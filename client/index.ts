// setup must go first
import './lib/SetupAwaitedHandler';

import { LocationStatus } from '@secret-agent/core-interfaces/Location';
import IConfigureOptions from '@secret-agent/core-interfaces/IConfigureOptions';
import { RenderingOption } from '@secret-agent/core-interfaces/ITabOptions';
import os from 'os';
import Browser, { createBrowser } from './lib/Browser';
import ICreateBrowserOptions from './interfaces/ICreateBrowserOptions';
import CoreClient from './lib/CoreClient';
import ISecretAgent, {
  ISecretAgentConfigureOptions,
  SecretAgentStatics,
} from './interfaces/ISecretAgent';
import Signals = NodeJS.Signals;

const DefaultOptions = {
  maxActiveSessionCount: 10,
  localProxyPortStart: 10e3,
  sessionsDir: os.tmpdir(),
  defaultRenderingOptions: [RenderingOption.All],
  defaultUserProfile: {},
};

export function SecretAgentClientGenerator(
  initArgs?: IClientInitArgs,
): {
  SecretAgent: ISecretAgent;
  coreClient: CoreClient;
} {
  const coreClient = new CoreClient();

  @SecretAgentStatics
  class SecretAgent {
    private static options: ISecretAgentConfigureOptions = { ...DefaultOptions };

    public static async configure(options: Partial<ISecretAgentConfigureOptions>): Promise<void> {
      this.options = { ...DefaultOptions, ...this.options, ...options };
      await coreClient.configure(options as IConfigureOptions);
    }

    public static async createBrowser(options: ICreateBrowserOptions = {}): Promise<Browser> {
      options.renderingOptions = options.renderingOptions || this.options.defaultRenderingOptions;
      options.userProfile = options.userProfile || this.options.defaultUserProfile;
      return createBrowser(options as ICreateBrowserOptions, coreClient);
    }

    public static async start(options: Partial<ISecretAgentConfigureOptions> = {}) {
      this.options = { ...DefaultOptions, ...this.options, ...options };
      await coreClient.start(options as IConfigureOptions);
    }

    public static async recordUnhandledError(error: Error) {
      await coreClient.logUnhandledError(error);
    }

    public static async shutdown(error?: Error) {
      await coreClient.shutdown(error);
    }
  }

  if (initArgs?.handleShutdownSignals) {
    ['exit', 'SIGTERM', 'SIGINT', 'SIGQUIT'].forEach(name => {
      process.once(name as Signals, async () => await SecretAgent.shutdown());
    });
  }

  if (initArgs?.captureUncaughtClientErrors) {
    process.on('uncaughtException', async (error: Error) => {
      // keep core node behavior intact
      process.stderr.write(`${error.stack}\n`);
      await SecretAgent.shutdown(error);
      process.exit(1);
    });

    process.on('unhandledRejection', async (error: Error) => {
      // keep core node behavior intact
      process.stderr.write(`${error.stack}\n`);
      await SecretAgent.recordUnhandledError(error);
    });
  }

  return { SecretAgent, coreClient };
}

interface IClientInitArgs {
  handleShutdownSignals: boolean;
  captureUncaughtClientErrors: boolean;
}

export { LocationStatus, ISecretAgent };
