import { createPromise, IResolvablePromise } from '@secret-agent/commons/utils';
import { ILifecycleEvents, IPuppetFrame } from '@secret-agent/puppet/interfaces/IPuppetFrame';
import { URL } from 'url';
import Protocol from 'devtools-protocol';
import { CanceledPromiseError } from '@secret-agent/commons/interfaces/IPendingWaitEvent';
import { TypedEventEmitter } from '@secret-agent/commons/eventUtils';
import { NavigationReason } from '@secret-agent/core-interfaces/INavigation';
import { IBoundLog } from '@secret-agent/commons/Logger';
import ProtocolError from '@secret-agent/puppet/lib/ProtocolError';
import { CDPSession } from './CDPSession';
import ConsoleMessage from './ConsoleMessage';
import { DEFAULT_PAGE, ISOLATED_WORLD } from './FramesManager';
import PageFrame = Protocol.Page.Frame;

export default class Frame extends TypedEventEmitter<IFrameEvents> implements IPuppetFrame {
  public get id() {
    return this.internalFrame.id;
  }

  public get name() {
    return this.internalFrame.name ?? '';
  }

  public get parentId() {
    return this.internalFrame.parentId;
  }

  public url: string;

  public get securityOrigin() {
    if (!this.isLoaded || this.url === DEFAULT_PAGE || !this.url) return null;
    const origin = this.internalFrame.securityOrigin;
    if (!origin || origin === '://') {
      return new URL(this.url).origin;
    }
    return origin;
  }

  public get isLoaded() {
    if (!this.activeLoaderId) return true;
    return this.activeLoader.isResolved;
  }

  public navigationReason?: string;
  public disposition?: string;

  public get lifecycleEvents() {
    return this.loaderLifecycles.get(this.activeLoaderId);
  }

  public loaderLifecycles = new Map<string, ILifecycleEvents>();

  protected readonly logger: IBoundLog;

  private loaderIdResolvers = new Map<string, IResolvablePromise<Error | null>>();
  private activeLoaderId: string;
  private readonly activeContexts: Set<number>;
  private readonly cdpSession: CDPSession;
  private readonly isAttached: () => boolean;

  private get activeLoader() {
    return this.loaderIdResolvers.get(this.activeLoaderId);
  }

  private defaultContextIds = new Set<number>();
  private isolatedContextIds = new Set<number>();
  private internalFrame: PageFrame;

  constructor(
    internalFrame: PageFrame,
    activeContexts: Set<number>,
    cdpSession: CDPSession,
    logger: IBoundLog,
    isAttached: () => boolean,
  ) {
    super();
    this.activeContexts = activeContexts;
    this.cdpSession = cdpSession;
    this.logger = logger.createChild(module);
    this.isAttached = isAttached;
    this.onLoaded(internalFrame);
  }

  public async evaluate<T>(expression: string, isolateFromWebPageEnvironment?: boolean) {
    const contextId = await this.waitForActiveContextId(isolateFromWebPageEnvironment);
    const result = await this.cdpSession.send(
      'Runtime.evaluate',
      {
        expression,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      },
      this,
    );
    if (result.exceptionDetails) {
      throw ConsoleMessage.exceptionToError(result.exceptionDetails);
    }

    const remote = result.result;
    if (remote.objectId) this.cdpSession.disposeRemoteObject(remote);
    return remote.value as T;
  }

  /////// NAVIGATION ///////////////////////////////////////////////////////////////////////////////////////////////////

  public initiateNavigation(url: string, loaderId: string) {
    // chain current listeners to new promise
    this.setLoader(loaderId);
  }

  public requestedNavigation(url: string, reason: NavigationReason, disposition: string) {
    this.navigationReason = reason;
    this.disposition = disposition;

    this.emit('frame-requested-navigation', { url, reason });
  }

  public onLoaded(internalFrame: PageFrame) {
    this.internalFrame = internalFrame;
    this.updateUrl();
    this.setLoader(internalFrame.loaderId);
    if (internalFrame.loaderId && this.url) {
      this.loaderIdResolvers.get(internalFrame.loaderId).resolve();
    }
  }

  public onNavigated(frame: PageFrame) {
    this.internalFrame = frame;
    this.updateUrl();

    let loader = this.activeLoader;
    if (frame.loaderId && frame.loaderId !== this.activeLoaderId) {
      loader = this.loaderIdResolvers.get(frame.loaderId) ?? this.activeLoader;
    }
    if (frame.unreachableUrl) {
      loader.resolve(new Error(`Unreachable url for navigation "${frame.unreachableUrl}"`));
    } else {
      loader.resolve();
    }

    this.emit('frame-navigated');
  }

  public onNavigatedWithinDocument(url: string) {
    this.url = url;

    // clear out any active one
    this.activeLoaderId = null;
    this.setLoader('inpage');
    this.loaderIdResolvers.get('inpage').resolve();
    this.emit('frame-navigated', { navigatedInDocument: true });
    this.onStoppedLoading();
  }

  /////// LIFECYCLE ////////////////////////////////////////////////////////////////////////////////////////////////////

  public onStoppedLoading() {
    if (!this.lifecycleEvents.load) {
      this.onLifecycleEvent('DOMContentLoaded');
      this.onLifecycleEvent('load');
    }
  }

  public async waitForLoader(loaderId?: string) {
    const hasLoaderError = await this.loaderIdResolvers.get(loaderId ?? this.activeLoaderId)
      ?.promise;
    if (hasLoaderError) return hasLoaderError;

    if (!this.getActiveContextId(false)) {
      await this.waitForDefaultContext();
    }
  }

  public onLifecycleEvent(name: string, pageLoaderId?: string) {
    const loaderId = pageLoaderId ?? this.activeLoaderId;
    if (name === 'init') {
      if (!this.loaderIdResolvers.has(loaderId)) {
        this.logger.info('Queuing new loader', {
          loaderId,
          frameId: this.id,
        });
        this.setLoader(loaderId);
      }
    }

    if (
      (name === 'commit' || name === 'DOMContentLoaded' || name === 'load') &&
      !this.loaderIdResolvers.get(loaderId)?.isResolved
    ) {
      this.logger.info('Resolving loader', {
        loaderId,
        frameId: this.id,
      });
      this.loaderIdResolvers.get(loaderId)?.resolve();
    }

    let lifecycle = this.lifecycleEvents;
    if (loaderId) {
      lifecycle = this.loaderLifecycles.get(loaderId) ?? this.lifecycleEvents;
    }

    if (lifecycle) {
      lifecycle[name] = new Date();
    }

    if (!this.isDefaultPage()) {
      this.emit('frame-lifecycle', { name });
    }
  }

  /////// CONTEXT ID  //////////////////////////////////////////////////////////////////////////////////////////////////

  public hasContextId(executionContextId: number) {
    return (
      this.defaultContextIds.has(executionContextId) ||
      this.isolatedContextIds.has(executionContextId)
    );
  }

  public addContextId(executionContextId: number, isDefault: boolean) {
    if (isDefault) {
      this.defaultContextIds.add(executionContextId);
      this.emit('default-context-created', { executionContextId });
    } else {
      this.isolatedContextIds.add(executionContextId);
      this.emit('isolated-context-created', { executionContextId });
    }
  }

  public async waitForActiveContextId(isolatedContext = true): Promise<number> {
    if (!this.isAttached()) throw new Error('Execution Context is not available in detached frame');

    const existing = this.getActiveContextId(isolatedContext);
    if (existing) return existing;

    if (isolatedContext) {
      const context = await this.createIsolatedWorld();
      // give one second to set up
      await new Promise(setImmediate);
      return context;
    }

    await this.waitForDefaultContext();
    return this.getActiveContextId(isolatedContext);
  }

  public getActiveContextId(isolatedContext: boolean) {
    if (isolatedContext) {
      for (const id of this.isolatedContextIds) {
        if (this.activeContexts.has(id)) return id;
      }
    } else {
      for (const id of this.defaultContextIds) {
        if (this.activeContexts.has(id)) return id;
      }
    }
  }

  public toJSON() {
    return {
      id: this.id,
      parentId: this.parentId,
      activeLoaderId: this.activeLoaderId,
      name: this.name,
      url: this.url,
      navigationReason: this.navigationReason,
      disposition: this.disposition,
    };
  }

  private setLoader(loaderId: string) {
    if (!loaderId) return;
    if (loaderId === this.activeLoaderId) return;
    if (loaderId === 'inpage' || !this.loaderIdResolvers.has(loaderId)) {
      this.loaderLifecycles.set(loaderId, {});
      const newResolver = createPromise();
      if (loaderId !== 'inpage') {
        const chain = newResolver.promise;
        newResolver.promise = this.createIsolatedWorld().then(() => chain);
      }

      if (this.activeLoader && !this.activeLoader.isResolved) {
        this.activeLoader.resolve(newResolver.promise);
      }

      this.loaderIdResolvers.set(loaderId, newResolver);
    }
    this.activeLoaderId = loaderId;
  }

  private async createIsolatedWorld() {
    try {
      if (!this.isAttached()) return;
      const isolatedWorld = await this.cdpSession.send(
        'Page.createIsolatedWorld',
        {
          frameId: this.id,
          worldName: ISOLATED_WORLD,
          // param is misspelled in protocol
          grantUniveralAccess: true,
        },
        this,
      );
      const { executionContextId } = isolatedWorld;
      this.activeContexts.add(executionContextId);
      this.addContextId(executionContextId, false);
      return executionContextId;
    } catch (error) {
      if (error instanceof CanceledPromiseError) {
        return;
      }
      if (error instanceof ProtocolError) {
        // 32000 code means frame doesn't exist, see if we just missed timing
        if (error.remoteError?.code === -32000) {
          if (!this.isAttached()) return;
        }
      }
      this.logger.warn('Failed to create isolated world.', {
        frameId: this.id,
        error,
      });
    }
  }

  private async waitForDefaultContext() {
    if (this.getActiveContextId(false)) return;

    // don't time out this event, we'll just wait for the page to shut down
    return this.waitOn('default-context-created', null, null).catch(err => {
      if (err instanceof CanceledPromiseError) return;
      throw err;
    });
  }

  private isDefaultPage() {
    return !this.url || this.url === DEFAULT_PAGE;
  }

  private updateUrl() {
    if (this.internalFrame.url) {
      this.url = this.internalFrame.url + (this.internalFrame.urlFragment ?? '');
    }
  }
}

interface IFrameEvents {
  'default-context-created': { executionContextId: number };
  'isolated-context-created': { executionContextId: number };
  'frame-lifecycle': { name: string };
  'frame-navigated': { navigatedInDocument?: boolean };
  'frame-requested-navigation': { url: string; reason: NavigationReason };
}
