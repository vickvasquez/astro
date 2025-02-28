import { dim, green } from 'kleur/colors';
import fs, { readFileSync } from 'node:fs';
import { basename, join } from 'node:path/posix';
import PQueue from 'p-queue';
import type { AstroConfig } from '../../@types/astro.js';
import type { BuildPipeline } from '../../core/build/buildPipeline.js';
import { getOutDirWithinCwd } from '../../core/build/common.js';
import { getTimeStat } from '../../core/build/util.js';
import type { Logger } from '../../core/logger/core.js';
import { isRemotePath, prependForwardSlash } from '../../core/path.js';
import { isServerLikeOutput } from '../../prerender/utils.js';
import type { MapValue } from '../../type-utils.js';
import { getConfiguredImageService, isESMImportedImage } from '../internal.js';
import type { LocalImageService } from '../services/service.js';
import type { AssetsGlobalStaticImagesList, ImageMetadata, ImageTransform } from '../types.js';
import { loadRemoteImage, type RemoteCacheEntry } from './remote.js';

interface GenerationDataUncached {
	cached: false;
	weight: {
		before: number;
		after: number;
	};
}

interface GenerationDataCached {
	cached: true;
}

type GenerationData = GenerationDataUncached | GenerationDataCached;

type AssetEnv = {
	logger: Logger;
	isSSR: boolean;
	count: { total: number; current: number };
	useCache: boolean;
	assetsCacheDir: URL;
	serverRoot: URL;
	clientRoot: URL;
	imageConfig: AstroConfig['image'];
	assetsFolder: AstroConfig['build']['assets'];
};

type ImageData = { data: Uint8Array; expires: number };

export async function prepareAssetsGenerationEnv(
	pipeline: BuildPipeline,
	totalCount: number
): Promise<AssetEnv> {
	const config = pipeline.getConfig();
	const logger = pipeline.getLogger();
	let useCache = true;
	const assetsCacheDir = new URL('assets/', config.cacheDir);
	const count = { total: totalCount, current: 1 };

	// Ensure that the cache directory exists
	try {
		await fs.promises.mkdir(assetsCacheDir, { recursive: true });
	} catch (err) {
		logger.warn(
			null,
			`An error was encountered while creating the cache directory. Proceeding without caching. Error: ${err}`
		);
		useCache = false;
	}

	let serverRoot: URL, clientRoot: URL;
	if (isServerLikeOutput(config)) {
		serverRoot = config.build.server;
		clientRoot = config.build.client;
	} else {
		serverRoot = getOutDirWithinCwd(config.outDir);
		clientRoot = config.outDir;
	}

	return {
		logger,
		isSSR: isServerLikeOutput(config),
		count,
		useCache,
		assetsCacheDir,
		serverRoot,
		clientRoot,
		imageConfig: config.image,
		assetsFolder: config.build.assets,
	};
}

function getFullImagePath(originalFilePath: string, env: AssetEnv): URL {
	return new URL(
		'.' + prependForwardSlash(join(env.assetsFolder, basename(originalFilePath))),
		env.serverRoot
	);
}

export async function generateImagesForPath(
	originalFilePath: string,
	transformsAndPath: MapValue<AssetsGlobalStaticImagesList>,
	env: AssetEnv,
	queue: PQueue
) {
	const originalImageData = await loadImage(originalFilePath, env);

	for (const [_, transform] of transformsAndPath.transforms) {
		queue.add(async () =>
			generateImage(originalImageData, transform.finalPath, transform.transform)
		);
	}

	// In SSR, we cannot know if an image is referenced in a server-rendered page, so we can't delete anything
	// For instance, the same image could be referenced in both a server-rendered page and build-time-rendered page
	if (
		!env.isSSR &&
		!isRemotePath(originalFilePath) &&
		!globalThis.astroAsset.referencedImages?.has(transformsAndPath.originalSrcPath)
	) {
		try {
			await fs.promises.unlink(getFullImagePath(originalFilePath, env));
		} catch (e) {
			/* No-op, it's okay if we fail to delete one of the file, we're not too picky. */
		}
	}

	async function generateImage(
		originalImage: ImageData,
		filepath: string,
		options: ImageTransform
	) {
		const timeStart = performance.now();
		const generationData = await generateImageInternal(originalImage, filepath, options);

		const timeEnd = performance.now();
		const timeChange = getTimeStat(timeStart, timeEnd);
		const timeIncrease = `(+${timeChange})`;
		const statsText = generationData.cached
			? `(reused cache entry)`
			: `(before: ${generationData.weight.before}kB, after: ${generationData.weight.after}kB)`;
		const count = `(${env.count.current}/${env.count.total})`;
		env.logger.info(
			null,
			`  ${green('▶')} ${filepath} ${dim(statsText)} ${dim(timeIncrease)} ${dim(count)}`
		);
		env.count.current++;
	}

	async function generateImageInternal(
		originalImage: ImageData,
		filepath: string,
		options: ImageTransform
	): Promise<GenerationData> {
		const isLocalImage = isESMImportedImage(options.src);
		const finalFileURL = new URL('.' + filepath, env.clientRoot);

		// For remote images, instead of saving the image directly, we save a JSON file with the image data and expiration date from the server
		const cacheFile = basename(filepath) + (isLocalImage ? '' : '.json');
		const cachedFileURL = new URL(cacheFile, env.assetsCacheDir);

		// Check if we have a cached entry first
		try {
			if (isLocalImage) {
				await fs.promises.copyFile(cachedFileURL, finalFileURL, fs.constants.COPYFILE_FICLONE);

				return {
					cached: true,
				};
			} else {
				const JSONData = JSON.parse(readFileSync(cachedFileURL, 'utf-8')) as RemoteCacheEntry;

				if (!JSONData.data || !JSONData.expires) {
					await fs.promises.unlink(cachedFileURL);

					throw new Error(
						`Malformed cache entry for ${filepath}, cache will be regenerated for this file.`
					);
				}

				// If the cache entry is not expired, use it
				if (JSONData.expires > Date.now()) {
					await fs.promises.writeFile(finalFileURL, Buffer.from(JSONData.data, 'base64'));

					return {
						cached: true,
					};
				} else {
					await fs.promises.unlink(cachedFileURL);
				}
			}
		} catch (e: any) {
			if (e.code !== 'ENOENT') {
				throw new Error(`An error was encountered while reading the cache file. Error: ${e}`);
			}
			// If the cache file doesn't exist, just move on, and we'll generate it
		}

		const finalFolderURL = new URL('./', finalFileURL);
		await fs.promises.mkdir(finalFolderURL, { recursive: true });

		// The original filepath or URL from the image transform
		const originalImagePath = isLocalImage
			? (options.src as ImageMetadata).src
			: (options.src as string);

		let resultData: Partial<ImageData> = {
			data: undefined,
			expires: originalImage.expires,
		};

		const imageService = (await getConfiguredImageService()) as LocalImageService;
		resultData.data = (
			await imageService.transform(
				originalImage.data,
				{ ...options, src: originalImagePath },
				env.imageConfig
			)
		).data;

		try {
			// Write the cache entry
			if (env.useCache) {
				if (isLocalImage) {
					await fs.promises.writeFile(cachedFileURL, resultData.data);
				} else {
					await fs.promises.writeFile(
						cachedFileURL,
						JSON.stringify({
							data: Buffer.from(resultData.data).toString('base64'),
							expires: resultData.expires,
						})
					);
				}
			}
		} catch (e) {
			env.logger.warn(
				null,
				`An error was encountered while creating the cache directory. Proceeding without caching. Error: ${e}`
			);
		} finally {
			// Write the final file
			await fs.promises.writeFile(finalFileURL, resultData.data);
		}

		return {
			cached: false,
			weight: {
				// Divide by 1024 to get size in kilobytes
				before: Math.trunc(originalImage.data.byteLength / 1024),
				after: Math.trunc(Buffer.from(resultData.data).byteLength / 1024),
			},
		};
	}
}

export function getStaticImageList(): AssetsGlobalStaticImagesList {
	if (!globalThis?.astroAsset?.staticImages) {
		return new Map();
	}

	return globalThis.astroAsset.staticImages;
}

async function loadImage(path: string, env: AssetEnv): Promise<ImageData> {
	if (isRemotePath(path)) {
		const remoteImage = await loadRemoteImage(path);
		return {
			data: remoteImage.data,
			expires: remoteImage.expires,
		};
	}

	return {
		data: await fs.promises.readFile(getFullImagePath(path, env)),
		expires: 0,
	};
}
