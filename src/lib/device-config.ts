import * as _ from 'lodash';

import * as Promise from 'bluebird';
import { stat, readFile, PathLike } from 'fs';

const statAsync = Promise.promisify(stat);
const readFileAsync = Promise.promisify(readFile as (
	path: PathLike | number,
	options: { encoding: string; flag?: string } | string,
	callback: (err: NodeJS.ErrnoException, data: string) => void,
) => void);

import * as deviceConfig from 'resin-device-config';
import * as resinSemver from 'resin-semver';

import { DeviceType } from './device-types';

import { captureException } from '../platform/errors';
import { getUser } from '../platform/auth';
import { createUserApiKey, createProvisioningApiKey } from './api-keys';
import { Request } from 'express';
import { Option as DeviceTypeOption } from '@resin.io/device-types';

// FIXME(refactor): many of the following are resin-specific
import {
	REGISTRY_HOST,
	REGISTRY2_HOST,
	NODE_EXTRA_CA_CERTS,
	MIXPANEL_TOKEN,
	VPN_HOST,
	VPN_PORT,
	API_HOST,
	DELTA_HOST,
} from './config';

export const generateConfig = (
	req: Request,
	app: AnyObject,
	deviceType: DeviceType,
	osVersion?: string,
) => {
	const userPromise = getUser(req);

	// Devices running ResinOS >= 2.0 can use Registry v2
	const registryHost = resinSemver.satisfies(osVersion, '<2.0.0')
		? REGISTRY_HOST
		: REGISTRY2_HOST;

	const apiKeyPromise = Promise.try(() => {
		// Devices running ResinOS >= 2.7.8 can use provisioning keys
		if (resinSemver.satisfies(osVersion, '<2.7.8')) {
			// Older ones have to use the old "user api keys"
			return userPromise.then(user => createUserApiKey(req, user.id));
		}
		return createProvisioningApiKey(req, app.id);
	});

	// There may be multiple CAs, this doesn't matter as all will be passed in the config
	const selfSignedRootPromise = Promise.try(() => {
		const caFile = NODE_EXTRA_CA_CERTS;
		if (!caFile) {
			return;
		}
		return statAsync(caFile)
			.then(() => readFileAsync(caFile, 'utf8'))
			.then(pem => Buffer.from(pem).toString('base64'))
			.catch({ code: 'ENOENT' }, _.noop)
			.catch(err => {
				captureException(err, 'Self-signed root CA could not be read');
			});
	});

	return Promise.join(
		userPromise,
		apiKeyPromise,
		selfSignedRootPromise,
		(user, apiKey, rootCA) => {
			const config = deviceConfig.generate(
				{
					application: app as deviceConfig.GenerateOptions['application'],
					deviceType: deviceType.slug,
					user,
					apiKey,
					pubnub: {},
					mixpanel: {
						token: MIXPANEL_TOKEN,
					},
					vpnPort: VPN_PORT,
					endpoints: {
						api: `https://${API_HOST}`,
						delta: `https://${DELTA_HOST}`,
						registry: registryHost,
						vpn: VPN_HOST,
					},
					version: osVersion,
				},
				{
					appUpdatePollInterval:
						_.parseInt(req.param('appUpdatePollInterval')) * 60 * 1000,
					network: req.param('network'),
					wifiSsid: req.param('wifiSsid'),
					wifiKey: req.param('wifiKey'),
					ip: req.param('ip'),
					gateway: req.param('gateway'),
					netmask: req.param('netmask'),
				},
			);

			_(deviceType.options!)
				.flatMap(
					(opt): DeviceTypeOption[] | DeviceTypeOption => {
						if (opt.isGroup && _.includes(['network', 'advanced'], opt.name)) {
							// already handled above
							return [];
						} else if (opt.isGroup) {
							return opt.options;
						} else {
							return opt;
						}
					},
				)
				.each(({ name: optionName }) => {
					config[optionName] = req.param(optionName);
				});
			if (rootCA != null) {
				config.balenaRootCA = rootCA;
			}
			return config;
		},
	);
};
