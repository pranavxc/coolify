import { asyncExecShell, createDirectories, getEngine, getUserDetails } from '$lib/common';
import * as db from '$lib/database';
import { promises as fs } from 'fs';
import yaml from 'js-yaml';
import type { RequestHandler } from '@sveltejs/kit';
import { letsEncrypt } from '$lib/letsencrypt';
import {
	checkHAProxy,
	configureSimpleServiceProxyOn,
	reloadHaproxy,
	setWwwRedirection
} from '$lib/haproxy';
import { getDomain } from '$lib/components/common';
import { getServiceImage, ErrorHandler } from '$lib/database';
import { makeLabelForServices } from '$lib/buildPacks/common';

export const post: RequestHandler = async (event) => {
	const { teamId, status, body } = await getUserDetails(event);
	if (status === 401) return { status, body };

	const { id } = event.params;

	try {
		await checkHAProxy();
		const service = await db.getService({ id, teamId });
		const { type, version, fqdn, destinationDockerId, destinationDocker } = service;

		const domain = getDomain(fqdn);
		const isHttps = fqdn.startsWith('https://');

		const network = destinationDockerId && destinationDocker.network;
		const host = getEngine(destinationDocker.engine);

		const { workdir } = await createDirectories({ repository: type, buildId: id });
		const baseImage = getServiceImage(type);

		const config = {
			image: `${baseImage}:${version}`,
			volume: `${id}-vaultwarden-data:/data/`
		};

		const composeFile = {
			version: '3.8',
			services: {
				[id]: {
					container_name: id,
					image: config.image,
					networks: [network],
					volumes: [config.volume],
					restart: 'always',
					labels: makeLabelForServices('vaultWarden')
				}
			},
			networks: {
				[network]: {
					external: true
				}
			},
			volumes: {
				[config.volume.split(':')[0]]: {
					external: true
				}
			}
		};
		const composeFileDestination = `${workdir}/docker-compose.yaml`;
		await fs.writeFile(composeFileDestination, yaml.dump(composeFile));
		try {
			await asyncExecShell(
				`DOCKER_HOST=${host} docker volume create ${config.volume.split(':')[0]}`
			);
		} catch (error) {
			console.log(error);
		}
		try {
			await asyncExecShell(`DOCKER_HOST=${host} docker compose -f ${composeFileDestination} up -d`);
			await configureSimpleServiceProxyOn({ id, domain, port: 80 });

			if (isHttps) {
				await letsEncrypt({ domain, id });
			}
			await setWwwRedirection(fqdn);
			await reloadHaproxy(destinationDocker.engine);
			return {
				status: 200
			};
		} catch (error) {
			return ErrorHandler(error);
		}
	} catch (error) {
		return ErrorHandler(error);
	}
};