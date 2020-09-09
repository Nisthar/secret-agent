import fs from 'fs';
import {
  IRequestSessionRequestEvent,
  IRequestSessionResponseEvent,
} from '@secret-agent/mitm/handlers/RequestSession';
import IWebsocketMessage from '@secret-agent/core-interfaces/IWebsocketMessage';
import IResourceMeta from '@secret-agent/core-interfaces/IResourceMeta';
import ICommandMeta from '@secret-agent/core-interfaces/ICommandMeta';
import Log, { ILogEntry, LogEvents } from '@secret-agent/commons/Logger';
import { IDomChangeEvent } from '@secret-agent/injected-scripts/interfaces/IDomChangeEvent';
import { LocationStatus } from '@secret-agent/core-interfaces/Location';
import IViewport from '@secret-agent/core-interfaces/IViewport';
import IPage from '@secret-agent/core-interfaces/IPage';
import { IMouseEvent } from '@secret-agent/injected-scripts/interfaces/IMouseEvent';
import { IFocusEvent } from '@secret-agent/injected-scripts/interfaces/IFocusEvent';
import { IScrollEvent } from '@secret-agent/injected-scripts/interfaces/IScrollEvent';
import IScriptInstanceMeta from '@secret-agent/core-interfaces/IScriptInstanceMeta';
import IWebsocketResourceMessage from '@secret-agent/core/interfaces/IWebsocketResourceMessage';
import PageHistory from './lib/PageHistory';
import { IFrameRecord } from './models/FramesTable';
import SessionsDb from './lib/SessionsDb';
import SessionDb from './lib/SessionDb';

const { log } = Log(module);

export default class SessionState {
  public static registry = new Map<string, SessionState>();
  public readonly commands: ICommandMeta[] = [];
  public get lastCommand() {
    if (this.commands.length === 0) return;
    return this.commands[this.commands.length - 1];
  }

  public readonly sessionId: string;

  public viewport: IViewport;
  public readonly pagesByTabId: { [tabId: string]: PageHistory } = {};
  public readonly db: SessionDb;

  private readonly sessionName: string;
  private readonly scriptInstanceMeta: IScriptInstanceMeta;
  private readonly createDate = new Date();
  private readonly frames: { [frameId: number]: IFrameRecord } = {};
  private readonly resources: IResourceMeta[] = [];
  private readonly websocketMessages: IWebsocketResourceMessage[] = [];
  private websocketListeners: {
    [resourceId: string]: ((msg: IWebsocketResourceMessage) => any)[];
  } = {};

  private readonly browserRequestIdToResourceId: { [browserRequestId: string]: number } = {};
  private lastErrorTime?: Date;
  private closeDate?: Date;

  private websocketMessageIdCounter = 0;

  private readonly logSubscriptionId: number;

  constructor(
    sessionsDirectory: string,
    sessionId: string,
    sessionName: string | null,
    scriptInstanceMeta: IScriptInstanceMeta,
    emulatorId: string,
    humanoidId: string,
    hasEmulatorPolyfills: boolean,
  ) {
    this.sessionId = sessionId;
    this.sessionName = sessionName;
    this.scriptInstanceMeta = scriptInstanceMeta;
    SessionState.registry.set(sessionId, this);

    fs.mkdirSync(sessionsDirectory, { recursive: true });

    this.db = new SessionDb(sessionsDirectory, sessionId);

    if (scriptInstanceMeta) {
      const sessionsTable = SessionsDb.find(sessionsDirectory).sessions;
      sessionsTable.insert(
        sessionId,
        sessionName,
        this.createDate.toISOString(),
        scriptInstanceMeta.id,
        scriptInstanceMeta.entrypoint,
        scriptInstanceMeta.startDate,
      );
    }

    this.db.session.insert(
      sessionId,
      sessionName,
      emulatorId,
      humanoidId,
      hasEmulatorPolyfills,
      this.createDate,
      scriptInstanceMeta?.id,
      scriptInstanceMeta?.entrypoint,
      scriptInstanceMeta?.startDate,
    );

    this.logSubscriptionId = LogEvents.subscribe(this.onLogEvent.bind(this));
  }

  public registerTab(tabId: string, parentTabId: string, openType?: string) {
    this.pagesByTabId[tabId] = new PageHistory(this.db);
  }

  public async runCommand<T>(commandFn: () => Promise<T>, commandMeta: ICommandMeta) {
    this.commands.push(commandMeta);

    let result: T;
    try {
      commandMeta.startDate = new Date().toISOString();
      this.db.commands.insert(commandMeta);

      result = await commandFn();
      return result;
    } catch (err) {
      result = err;
      throw err;
    } finally {
      commandMeta.endDate = new Date().toISOString();
      commandMeta.result = result;
      // NOTE: second insert on purpose -- it will do an update
      this.db.commands.insert(commandMeta);
    }
  }

  public onWebsocketMessages(resourceId: number, listenerFn: (message: IWebsocketMessage) => any) {
    if (!this.websocketListeners[resourceId]) {
      this.websocketListeners[resourceId] = [];
    }
    this.websocketListeners[resourceId].push(listenerFn);
    // push all existing
    for (const message of this.websocketMessages) {
      if (message.resourceId === resourceId) {
        listenerFn(message);
      }
    }
  }

  public stopWebsocketMessages(
    resourceId: string,
    listenerFn: (message: IWebsocketMessage) => any,
  ) {
    const listeners = this.websocketListeners[resourceId];
    if (!listeners) return;
    const idx = listeners.indexOf(listenerFn);
    if (idx >= 0) listeners.splice(idx, 1);
  }

  public captureWebsocketMessage(event: {
    browserRequestId: string;
    isFromServer: boolean;
    message: string | Buffer;
  }) {
    const { browserRequestId, isFromServer, message } = event;
    const resourceId = this.browserRequestIdToResourceId[browserRequestId];
    if (!resourceId) {
      log.error(`CaptureWebsocketMessageError.UnregisteredResource`, {
        sessionId: this.sessionId,
        browserRequestId,
        message,
      });
      return;
    }

    const resourceMessage = {
      resourceId,
      message,
      messageId: this.websocketMessageIdCounter += 1,
      source: isFromServer ? 'server' : 'client',
    } as IWebsocketResourceMessage;

    this.websocketMessages.push(resourceMessage);
    this.db.websocketMessages.insert(this.lastCommand?.id, resourceMessage);

    const listeners = this.websocketListeners[resourceMessage.resourceId];
    if (listeners) {
      for (const listener of listeners) {
        listener(resourceMessage);
      }
    }
    return resourceMessage;
  }

  public captureResource(
    tabId: string,
    resourceEvent: IRequestSessionResponseEvent | IRequestSessionRequestEvent,
    isResponse: boolean,
  ): IResourceMeta {
    const { request } = resourceEvent;
    const {
      response,
      resourceType,
      body,
      executionMillis,
      browserRequestId,
      redirectedToUrl,
      wasCached,
    } = resourceEvent as IRequestSessionResponseEvent;

    if (browserRequestId) {
      this.browserRequestIdToResourceId[browserRequestId] = resourceEvent.id;
    }

    const resource = {
      id: resourceEvent.id,
      tabId,
      url: request.url,
      receivedAtCommandId: this.lastCommand?.id,
      type: resourceType,
      isRedirect: !!redirectedToUrl,
      request: {
        ...request,
        postData: request.postData?.toString(),
      },
    } as IResourceMeta;

    if (isResponse && response?.statusCode) {
      resource.response = response;
      if (response.url) resource.url = response.url;
      else resource.response.url = request.url;
    }

    this.db.resources.insert(tabId, resource, body, resourceEvent);

    if (isResponse) {
      log.info('Http.Response', {
        sessionId: this.sessionId,
        url: request.url,
        method: request.method,
        headers: response.headers,
        wasCached,
        executionMillis,
        bytes: body ? Buffer.byteLength(body) : -1,
      });
      const pages = this.pagesByTabId[tabId];
      if (resource.url === pages?.currentUrl && request.method !== 'OPTIONS') {
        pages.resourceLoadedForLocation(resource.id);
      }
      this.resources.push(resource);
    }
    return resource;
  }

  public getResources(tabId: string) {
    return this.resources.filter(x => x.tabId === tabId);
  }

  public async getResourceData(id: number) {
    return this.db.getResourceData(id);
  }

  public getResourceMeta(id: number) {
    return this.resources.find(x => x.id === id);
  }

  ///////   FRAMES ///////

  public captureFrameCreated(tabId: string, frameId: string, parentFrameId: string | null) {
    const frame = {
      id: frameId,
      tabId,
      parentId: parentFrameId,
      startCommandId: this.lastCommand?.id,
      url: null,
      createdTime: new Date().toISOString(),
    } as IFrameRecord;
    this.frames[frameId] = frame;
    this.db.frames.insert(frame);
  }

  public captureError(tabId: string, frameId: string, source: string, error: Error) {
    log.error('Window.error', { sessionId: this.sessionId, source, error });
    this.db.pageLogs.insert(tabId, frameId, source, error.stack || String(error), new Date());
  }

  public captureLog(
    tabId: string,
    frameId: string,
    consoleType: string,
    message: string,
    location?: string,
  ) {
    if (message.includes('Error: ') || message.startsWith('ERROR')) {
      log.error('Window.error', { sessionId: this.sessionId, message });
    } else {
      log.info('Window.console', { sessionId: this.sessionId, message });
    }
    this.db.pageLogs.insert(tabId, frameId, consoleType, message, new Date(), location);
  }

  public onLogEvent(entry: ILogEntry) {
    if (entry.sessionId === this.sessionId || !entry.sessionId) {
      if (entry.action === 'Window.runCommand') entry.data = { id: entry.data.id };
      if (entry.action === 'Window.ranCommand') entry.data = null;
      if (entry.level === 'error') {
        this.lastErrorTime = entry.timestamp;
      }
      this.db.sessionLogs.insert(entry);
    }
  }

  public async saveState() {
    this.closeDate = new Date();
    this.db.session.update(this.sessionId, {
      closeDate: this.closeDate,
      viewport: this.viewport,
    });
    LogEvents.unsubscribe(this.logSubscriptionId);
    this.db.flush();
    this.db.close();
    SessionState.registry.delete(this.sessionId);
  }

  public checkForResponsive() {
    let lastSuccessDate = this.createDate;
    for (const pages of Object.values(this.pagesByTabId)) {
      const allContentLoaded = pages.top?.stateChanges?.get('AllContentLoaded');
      const lastPageTime = allContentLoaded ?? pages.top?.initiatedTime;
      if (lastPageTime && lastPageTime > lastSuccessDate) {
        lastSuccessDate = lastPageTime;
      }
      for (const command of this.commands) {
        if (!command.endDate) continue;
        const endDate = new Date(command.endDate);
        if (
          allContentLoaded &&
          endDate > lastSuccessDate &&
          !command.resultType?.includes('Error')
        ) {
          lastSuccessDate = endDate;
        }
      }
    }

    const hasRecentErrors = this.lastErrorTime >= lastSuccessDate;

    const lastCommand = this.lastCommand;
    let unresponsiveSeconds = 0;
    if (lastCommand) {
      const lastCommandDate = new Date(lastCommand.endDate ?? lastCommand.startDate).getTime();
      unresponsiveSeconds = Math.floor((new Date().getTime() - lastCommandDate) / 1000);
    }
    return {
      hasRecentErrors,
      unresponsiveSeconds,
      closeTime: this.closeDate,
    };
  }

  public async getPageDomChanges(pages: IPage[], sinceCommandId?: number) {
    return this.db.getDomChanges(
      pages.map(x => x.frameId),
      sinceCommandId,
    );
  }

  public onPageEvents(
    tabId: string,
    frameId: string,
    domChanges: IDomChangeEvent[],
    mouseEvents: IMouseEvent[],
    focusEvents: IFocusEvent[],
    scrollEvents: IScrollEvent[],
  ) {
    log.stats('State.onPageEvents', {
      sessionId: this.sessionId,
      tabId,
      frameId,
      dom: domChanges.length,
      mouse: mouseEvents.length,
      focusEvents: focusEvents.length,
      scrollEvents: scrollEvents.length,
    });
    const maxCommandId = domChanges.reduce((max, change) => {
      if (max > change[0]) return max;
      return change[0];
    }, -1);

    let startCommandId = maxCommandId;
    const pages = this.pagesByTabId[tabId];
    // find last page load
    for (let i = pages.history.length - 1; i >= 0; i -= 1) {
      const page = pages.history[i];
      if (page.stateChanges.has(LocationStatus.HttpResponded)) {
        startCommandId = page.startCommandId;
        break;
      }
    }

    for (const domChange of domChanges) {
      if (domChange[0] === -1) domChange[0] = startCommandId;
      this.db.domChanges.insert(tabId, frameId, domChange);
    }

    for (const mouseEvent of mouseEvents) {
      if (mouseEvent[0] === -1) mouseEvent[0] = startCommandId;
      this.db.mouseEvents.insert(tabId, mouseEvent);
    }

    for (const focusEvent of focusEvents) {
      if (focusEvent[0] === -1) focusEvent[0] = startCommandId;
      this.db.focusEvents.insert(tabId, focusEvent);
    }

    for (const scrollEvent of scrollEvents) {
      if (scrollEvent[0] === -1) scrollEvent[0] = startCommandId;
      this.db.scrollEvents.insert(tabId, scrollEvent);
    }
  }
}
