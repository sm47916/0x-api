// tslint:disable-next-line:ordered-imports no-var-requires
require('./apm');

import {
    artifacts,
    AssetSwapperContractAddresses,
    ContractAddresses,
    ERC20BridgeSamplerContract,
    SupportedProvider,
} from '@0x/asset-swapper';
import { getContractAddressesForChainOrThrow } from '@0x/contract-addresses';
import { Web3Wrapper } from '@0x/dev-utils';
import * as express from 'express';
import { Server } from 'http';
import { Connection } from 'typeorm';

import { CHAIN_ID } from './config';
import { RFQ_FIRM_QUOTE_CACHE_EXPIRY, SRA_PATH } from './constants';
import { getDBConnectionAsync } from './db_connection';
import { MakerBalanceChainCacheEntity } from './entities/MakerBalanceChainCacheEntity';
import { logger } from './logger';
import { runHttpServiceAsync } from './runners/http_service_runner';
import { runOrderWatcherServiceAsync } from './runners/order_watcher_service_runner';
import { MetaTransactionService } from './services/meta_transaction_service';
import { OrderBookService } from './services/orderbook_service';
import { PostgresRfqtFirmQuoteValidator } from './services/postgres_rfqt_firm_quote_validator';
import { SwapService } from './services/swap_service';
import { TransactionWatcherSignerService } from './services/transaction_watcher_signer_service';
import {
    ChainId,
    HttpServiceConfig,
    MetaTransactionDailyLimiterConfig,
    MetaTransactionRollingLimiterConfig,
    WebsocketSRAOpts,
} from './types';
import { AssetSwapperOrderbook } from './utils/asset_swapper_orderbook';
import { MeshClient } from './utils/mesh_client';
import {
    AvailableRateLimiter,
    DatabaseKeysUsedForRateLimiter,
    MetaTransactionDailyLimiter,
    MetaTransactionRateLimiter,
    MetaTransactionRollingLimiter,
} from './utils/rate-limiters';
import { MetaTransactionComposableLimiter } from './utils/rate-limiters/meta_transaction_composable_rate_limiter';

export interface AppDependencies {
    contractAddresses: ContractAddresses;
    connection: Connection;
    meshClient?: MeshClient;
    orderBookService: OrderBookService;
    swapService?: SwapService;
    metaTransactionService?: MetaTransactionService;
    provider: SupportedProvider;
    websocketOpts: Partial<WebsocketSRAOpts>;
    transactionWatcherService?: TransactionWatcherSignerService;
    rateLimiter?: MetaTransactionRateLimiter;
}

async function deploySamplerContractAsync(
    provider: SupportedProvider,
    chainId: ChainId,
): Promise<ERC20BridgeSamplerContract> {
    const web3Wrapper = new Web3Wrapper(provider);
    const _chainId = await web3Wrapper.getChainIdAsync();
    if (_chainId !== chainId) {
        throw new Error(`Incorrect Chain Id: ${_chainId}`);
    }
    const [account] = await web3Wrapper.getAvailableAddressesAsync();
    try {
        const sampler = await ERC20BridgeSamplerContract.deployFrom0xArtifactAsync(
            artifacts.ERC20BridgeSampler,
            provider,
            { from: account },
            {},
        );
        logger.info(`Deployed ERC20BridgeSamplerContract on network ${chainId}: ${sampler.address}`);
        return sampler;
    } catch (err) {
        logger.error(`Failed to deploy ERC20BridgeSamplerContract on network ${chainId}: ${err}`);
        throw err;
    }
}

let contractAddresses_: AssetSwapperContractAddresses | undefined;

/**
 * Determines the contract addresses needed for the network. For testing (ganache)
 * required contracts are deployed
 * @param provider provider to the network, used for ganache deployment
 * @param chainId the network chain id
 */
export async function getContractAddressesForNetworkOrThrowAsync(
    provider: SupportedProvider,
    chainId: ChainId,
): Promise<AssetSwapperContractAddresses> {
    // If global exists, use that
    if (contractAddresses_) {
        return contractAddresses_;
    }
    let contractAddresses = getContractAddressesForChainOrThrow(chainId.toString() as any);
    // In a testnet where the environment does not support overrides
    // so we deploy the latest sampler
    if (chainId === ChainId.Ganache) {
        const sampler = await deploySamplerContractAsync(provider, chainId);
        contractAddresses = { ...contractAddresses, erc20BridgeSampler: sampler.address };
    }
    // Set the global cached contractAddresses_
    contractAddresses_ = contractAddresses;
    return contractAddresses_;
}

/**
 * Instantiates dependencies required to run the app. Uses default settings based on config
 * @param config should contain a URI for mesh to listen to, and the ethereum RPC URL
 */
export async function getDefaultAppDependenciesAsync(
    provider: SupportedProvider,
    config: HttpServiceConfig,
): Promise<AppDependencies> {
    const contractAddresses = await getContractAddressesForNetworkOrThrowAsync(provider, CHAIN_ID);
    const connection = await getDBConnectionAsync();

    let meshClient: MeshClient | undefined;
    if (config.meshWebsocketUri !== undefined && config.meshHttpUri !== undefined) {
        meshClient = new MeshClient(config.meshWebsocketUri, config.meshHttpUri);
        // HACK(kimpers): Need to wait for Mesh initialization to finish before we can subscribe to event updates
        // When the stats request has resolved Mesh is ready to receive subscriptions
        await meshClient.getStatsAsync();
    } else {
        logger.warn(`Skipping Mesh client creation because no URI provided`);
    }

    let rateLimiter: MetaTransactionRateLimiter | undefined;
    if (config.metaTxnRateLimiters !== undefined) {
        rateLimiter = createMetaTransactionRateLimiterFromConfig(connection, config);
    }

    const orderBookService = new OrderBookService(connection, meshClient);

    const rfqtFirmQuoteValidator = new PostgresRfqtFirmQuoteValidator(
        connection.getRepository(MakerBalanceChainCacheEntity),
        RFQ_FIRM_QUOTE_CACHE_EXPIRY,
    );

    let swapService: SwapService | undefined;
    let metaTransactionService: MetaTransactionService | undefined;
    try {
        swapService = new SwapService(
            new AssetSwapperOrderbook(orderBookService),
            provider,
            contractAddresses,
            rfqtFirmQuoteValidator,
        );
        metaTransactionService = createMetaTxnServiceFromSwapService(
            provider,
            connection,
            swapService,
            contractAddresses,
        );
    } catch (err) {
        logger.error(err.stack);
    }

    const websocketOpts = { path: SRA_PATH };

    return {
        contractAddresses,
        connection,
        meshClient,
        orderBookService,
        swapService,
        metaTransactionService,
        provider,
        websocketOpts,
        rateLimiter,
    };
}
/**
 * starts the app with dependencies injected. This entry-point is used when running a single instance 0x API
 * deployment and in tests. It is not used in production deployments where scaling is required.
 * @param dependencies  all values are optional and will be filled with reasonable defaults, with one
 *                      exception. if a `meshClient` is not provided, the API will start without a
 *                      connection to mesh.
 * @return the app object
 */
export async function getAppAsync(
    dependencies: AppDependencies,
    config: HttpServiceConfig,
): Promise<{ app: Express.Application; server: Server }> {
    const app = express();
    const { server, wsService } = await runHttpServiceAsync(dependencies, config, app);
    if (dependencies.meshClient !== undefined) {
        try {
            await runOrderWatcherServiceAsync(dependencies.connection, dependencies.meshClient);
        } catch (e) {
            logger.error(`Error attempting to start Order Watcher service, [${JSON.stringify(e)}]`);
        }
    } else {
        logger.warn('No mesh client provided, API running without Order Watcher');
    }
    // Register a shutdown event listener.
    // TODO: More teardown logic should be added here. For example, the mesh rpc
    // client should be destroyed and services should be torn down.
    server.on('close', async () => {
        await wsService.destroyAsync();
    });

    return { app, server };
}

function createMetaTransactionRateLimiterFromConfig(
    dbConnection: Connection,
    config: HttpServiceConfig,
): MetaTransactionRateLimiter {
    const rateLimiterConfigEntries = Object.entries(config.metaTxnRateLimiters!);
    const configuredRateLimiters = rateLimiterConfigEntries
        .map(entries => {
            const [dbField, rateLimiters] = entries;

            return Object.entries(rateLimiters!).map(rateLimiterEntry => {
                const [limiterType, value] = rateLimiterEntry;
                switch (limiterType) {
                    case AvailableRateLimiter.Daily: {
                        const dailyConfig = value as MetaTransactionDailyLimiterConfig;
                        return new MetaTransactionDailyLimiter(
                            dbField as DatabaseKeysUsedForRateLimiter,
                            dbConnection,
                            dailyConfig,
                        );
                    }
                    case AvailableRateLimiter.Rolling: {
                        const rollingConfig = value as MetaTransactionRollingLimiterConfig;
                        return new MetaTransactionRollingLimiter(
                            dbField as DatabaseKeysUsedForRateLimiter,
                            dbConnection,
                            rollingConfig,
                        );
                    }
                    default:
                        throw new Error('unknown rate limiter type');
                }
            });
        })
        .reduce((prev, cur) => {
            return prev.concat(...cur);
        }, []);
    return new MetaTransactionComposableLimiter(configuredRateLimiters);
}

/**
 * Instantiates MetaTransactionService using the provided OrderBookService,
 * ethereum RPC provider and db connection.
 */
export function createMetaTxnServiceFromSwapService(
    provider: SupportedProvider,
    dbConnection: Connection,
    swapService: SwapService,
    contractAddresses: ContractAddresses,
): MetaTransactionService {
    return new MetaTransactionService(provider, dbConnection, swapService, contractAddresses);
}
