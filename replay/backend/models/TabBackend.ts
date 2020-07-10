import { BrowserView } from 'electron';
import { URL } from 'url';
import { v1 as uuidv1 } from 'uuid';
import * as http from 'http';
import Window from './Window';
import generateContextMenu from '../menus/generateContextMenu';
import ITabLocation, { InternalLocations } from '~shared/interfaces/ITabLocation';
import { INTERNAL_BASE_URL } from '~shared/constants/files';
import ReplayApi from '~backend/ReplayApi';
import IRectangle from '~shared/interfaces/IRectangle';
import Rectangle = Electron.Rectangle;
import Application from '~backend/Application';
import ipcMain = Electron.ipcMain;
import ICommandResult from '~shared/interfaces/ICommandResult';
import { ITick } from '~shared/interfaces/ISaSession';

const domReplayerScript = require.resolve('../../injected-scripts/domReplayer');

interface IAddressBarOptions {
  location?: ITabLocation;
  replayApi?: ReplayApi;
}

export default class TabBackend {
  public browserView: BrowserView;
  public replayApi: ReplayApi;

  public favicon = '';
  public findInfo = {
    occurrences: '0/0',
    text: '',
  };

  private bounds: Rectangle;
  private location: InternalLocations = InternalLocations.Home;

  private readonly window: Window;

  public constructor(window: Window, { location, replayApi }: IAddressBarOptions) {
    this.browserView = new BrowserView({
      webPreferences: {
        preload: domReplayerScript,
        nodeIntegration: true,
        contextIsolation: false,
        javascript: true,
        enableRemoteModule: true,
        partition: uuidv1(),
        nativeWindowOpen: true,
        webSecurity: true,
        // sandbox: true, // ToDo: turn this back on for snapshots
      },
    });

    (this.webContents as any).windowId = window.browserWindow.id;

    this.window = window;
    this.browserView.setAutoResize({
      width: true,
      height: true,
      horizontal: false,
      vertical: false,
    });

    this.bindProxy();
    this.bindListeners();
    this.updateAddressBar({ location, replayApi }, true);
  }

  public get webContents() {
    return this.browserView.webContents;
  }

  public get title() {
    return this.webContents.getTitle();
  }

  public get id() {
    return this.webContents.id;
  }

  public get isSelected() {
    return this.id === this.window.tabManager.selectedId;
  }

  public updateAddressBar({ location, replayApi }: IAddressBarOptions, isNewTab: boolean = false) {
    if (this.browserView.isDestroyed()) return;

    if (!isNewTab && this.window.tabManager.selectedId !== this.id) return;

    if (this.replayApi) {
      this.replayApi.removeAllListeners('session:updated');
    }

    const tabUpdateParams: any = { id: this.id, currentTickValue: 0 };
    if (location) {
      tabUpdateParams.location = location;
      location = location === InternalLocations.NewTab ? InternalLocations.Home : location;
      this.location = location as InternalLocations;
      this.webContents.loadURL(`${INTERNAL_BASE_URL}/${location.toLowerCase()}`);
      this.replayApi = null;
    } else {
      this.location = InternalLocations.Replay;
      tabUpdateParams.saSession = replayApi.saSession;
      this.webContents.loadURL(`http://localhost:3333/${InternalLocations.Replay.toLowerCase()}`);
      this.replayApi = replayApi;
      this.replayApi.on('session:updated', this.updateTabSession.bind(this));
    }

    this.window.sendToRenderer('tab:updated', tabUpdateParams);
  }

  public async onTick(tickValue: number) {
    const ticks = this.replayApi.saSession.ticks;

    let lastTick: ITick;
    for (const tick of ticks) {
      lastTick = tick;
      if (tick.playbarOffsetPercent > tickValue) break;
    }

    if (!lastTick) return;

    let lastPaintIndex: number;
    const paintEventTicks = lastTick.minorTicks.map(t => t.paintEventIdx).filter(Boolean);
    if (lastTick.minorTicks.length) {
      lastPaintIndex = Math.max(...paintEventTicks);
    } else {
      const startIndex = ticks.indexOf(lastTick);

      for (let i = startIndex; i >= 0; i -= 1) {
        const tick = ticks[i];
        const prevPaintEventTicks = tick.minorTicks.map(t => t.paintEventIdx).filter(Boolean);
        if (prevPaintEventTicks.length) {
          lastPaintIndex = Math.max(...prevPaintEventTicks);
        }
      }
    }

    const changeEvents =
      lastPaintIndex === undefined ? null : await this.replayApi.setPaintIndex(lastPaintIndex);

    const highlightNodeIds = this.findPreviousResultHighlight(lastTick.commandId);
    this.send('dom:apply', changeEvents, highlightNodeIds);
  }

  public async onTickHover(rect: IRectangle, tickValue: number) {
    const tick = this.replayApi.saSession.ticks.find(x => x.playbarOffsetPercent === tickValue);
    if (!tick) return;

    const commandLabel = tick.label;
    const commandResult = this.replayApi.saSession.commandResults.find(
      x => x.commandId === tick.commandId,
    );
    Application.instance.overlayManager.show(
      'command-overlay',
      this.window.browserWindow,
      rect,
      commandLabel,
      commandResult,
    );
  }

  public destroy() {
    this.browserView.destroy();
    this.browserView = null;
  }

  public fixBounds(newBounds: { x: number; width: number; y: any; height: number }) {
    const bounds = this.bounds ?? ({} as Rectangle);
    if (
      newBounds.x !== bounds.x ||
      newBounds.y !== bounds.y ||
      newBounds.width !== bounds.width ||
      newBounds.height !== bounds.height
    ) {
      this.browserView.setBounds(newBounds);
      this.bounds = newBounds;
    }
  }

  public send(channel: string, ...args: any[]) {
    this.webContents.send(channel, ...args);
  }

  public addToWindow() {
    this.window.browserWindow.addBrowserView(this.browserView);
  }

  public removeFromWindow() {
    this.window.browserWindow.removeBrowserView(this.browserView);
  }

  private updateTabSession() {
    if (!this.replayApi) return;
    const tabUpdateParam = {
      id: this.id,
      saSession: this.replayApi.saSession,
    };
    this.window.sendToRenderer('tab:updated', tabUpdateParam);
  }

  private findPreviousResultHighlight(commandId: number) {
    const commandIndex = this.replayApi.saSession.commandResults.findIndex(
      x => x.commandId === commandId,
    );
    for (let i = commandIndex; i >= 0; i -= 1) {
      const result = this.replayApi.saSession.commandResults[i];
      if (result.resultNodeIds?.length) {
        return result.resultNodeIds;
      }
    }
  }

  private bindProxy() {
    const session = this.webContents.session;
    session.protocol.interceptHttpProtocol('http', (request, callback) => {
      const parsedUrl = new URL(request.url, 'http://localhost:3000/');
      if (parsedUrl.host === 'localhost:3000') {
        callback({ url: request.url });
      } else if (parsedUrl.host === 'localhost:3333' && parsedUrl.pathname === '/replay') {
        callback({ url: 'http://localhost:3000/replay.html' });
      } else {
        const cleanedUrl = request.url.replace('http://localhost:3333', this.replayApi.urlOrigin);
        const resourceUrl = this.replayApi.resourceUrl(cleanedUrl);
        callback({ url: resourceUrl });
      }
    });
  }

  private bindListeners() {
    this.webContents.on('context-menu', (e, params) => {
      generateContextMenu(this.window, params, this.webContents).popup();
    });

    // this.webContents.addListener('found-in-page', (e, result) => {
    //   Application.instance.overlayManager
    //     .getByName('find')
    //     .browserView.webContents.send('found-in-page', result);
    // });

    this.webContents.addListener('did-start-loading', () => {
      this.window.sendToRenderer('tab:updated-loading', this.id, true);
    });

    this.webContents.addListener('did-stop-loading', () => {
      this.window.sendToRenderer('tab:updated-loading', this.id, false);
    });
  }
}