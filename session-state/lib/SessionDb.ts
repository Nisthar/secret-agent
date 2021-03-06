import Database, { Database as SqliteDatabase, Transaction } from 'better-sqlite3';
import * as Path from 'path';
import Log from '@secret-agent/commons/Logger';
import SqliteTable from '@secret-agent/commons/SqliteTable';
import ResourcesTable from '../models/ResourcesTable';
import DomChangesTable from '../models/DomChangesTable';
import CommandsTable from '../models/CommandsTable';
import WebsocketMessagesTable from '../models/WebsocketMessagesTable';
import FrameNavigationsTable from '../models/FrameNavigationsTable';
import FramesTable from '../models/FramesTable';
import PageLogsTable from '../models/PageLogsTable';
import SessionTable from '../models/SessionTable';
import MouseEventsTable from '../models/MouseEventsTable';
import FocusEventsTable from '../models/FocusEventsTable';
import ScrollEventsTable from '../models/ScrollEventsTable';
import SessionLogsTable from '../models/SessionLogsTable';
import SessionsDb from './SessionsDb';
import SessionState from '../index';
import DevtoolsMessagesTable from '../models/DevtoolsMessagesTable';
import TabsTable from '../models/TabsTable';
import ResourceStatesTable from '../models/ResourceStatesTable';

const { log } = Log(module);

interface IDbOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

export default class SessionDb {
  public readonly readonly: boolean;
  public readonly commands: CommandsTable;
  public readonly frames: FramesTable;
  public readonly frameNavigations: FrameNavigationsTable;
  public readonly resources: ResourcesTable;
  public readonly resourceStates: ResourceStatesTable;
  public readonly websocketMessages: WebsocketMessagesTable;
  public readonly domChanges: DomChangesTable;
  public readonly pageLogs: PageLogsTable;
  public readonly sessionLogs: SessionLogsTable;
  public readonly session: SessionTable;
  public readonly mouseEvents: MouseEventsTable;
  public readonly focusEvents: FocusEventsTable;
  public readonly scrollEvents: ScrollEventsTable;
  public readonly devtoolsMessages: DevtoolsMessagesTable;
  public readonly tabs: TabsTable;
  public readonly sessionId: string;

  private readonly batchInsert?: Transaction;
  private readonly saveInterval: NodeJS.Timeout;

  private db: SqliteDatabase;
  private readonly tables: SqliteTable<any>[] = [];

  constructor(baseDir: string, id: string, dbOptions: IDbOptions = {}) {
    const { readonly = false, fileMustExist = false } = dbOptions;
    this.sessionId = id;
    this.db = new Database(`${baseDir}/${id}.db`, { readonly, fileMustExist });
    if (!readonly) {
      this.saveInterval = setInterval(this.flush.bind(this), 5e3).unref();
    }
    this.readonly = readonly;

    this.commands = new CommandsTable(this.db);
    this.tabs = new TabsTable(this.db);
    this.frames = new FramesTable(this.db);
    this.frameNavigations = new FrameNavigationsTable(this.db);
    this.resources = new ResourcesTable(this.db);
    this.resourceStates = new ResourceStatesTable(this.db);
    this.websocketMessages = new WebsocketMessagesTable(this.db);
    this.domChanges = new DomChangesTable(this.db);
    this.pageLogs = new PageLogsTable(this.db);
    this.session = new SessionTable(this.db);
    this.mouseEvents = new MouseEventsTable(this.db);
    this.focusEvents = new FocusEventsTable(this.db);
    this.scrollEvents = new ScrollEventsTable(this.db);
    this.sessionLogs = new SessionLogsTable(this.db);
    this.devtoolsMessages = new DevtoolsMessagesTable(this.db);

    this.tables.push(
      this.commands,
      this.tabs,
      this.frames,
      this.frameNavigations,
      this.resources,
      this.resourceStates,
      this.websocketMessages,
      this.domChanges,
      this.pageLogs,
      this.session,
      this.mouseEvents,
      this.focusEvents,
      this.scrollEvents,
      this.sessionLogs,
      this.devtoolsMessages,
    );

    if (!readonly) {
      this.batchInsert = this.db.transaction(() => {
        for (const table of this.tables) {
          try {
            table.flush();
          } catch (error) {
            log.error('SessionDb.flushError', {
              sessionId: this.sessionId,
              error,
              table: table.tableName,
            });
          }
        }
      });
    }
  }

  public getDomChanges(frameIds: string[], sinceCommandId: number) {
    this.flush();

    return this.domChanges.getFrameChanges(frameIds, sinceCommandId);
  }

  public getResourceData(resourceId: number) {
    if (this.resources.hasPending()) {
      this.flush();
    }

    return this.resources.getResourceBodyById(resourceId);
  }

  public close() {
    if (this.db) {
      clearInterval(this.saveInterval);
      this.flush();
      this.db.close();
    }
    this.db = null;
  }

  public flush() {
    if (this.batchInsert) this.batchInsert.immediate();
  }

  public static findWithRelated(scriptArgs: {
    scriptInstanceId: string;
    sessionName: string;
    scriptEntrypoint: string;
    dataLocation: string;
    sessionId?: string;
  }) {
    let { dataLocation, sessionId } = scriptArgs;

    const ext = Path.extname(dataLocation);
    if (ext === '.db') {
      sessionId = Path.basename(dataLocation, ext);
      dataLocation = Path.dirname(dataLocation);
    }

    // NOTE: don't close db - it's from a shared cache
    const sessionsDb = SessionsDb.find(dataLocation);
    if (!sessionId) {
      sessionId = sessionsDb.findLatestSessionId(scriptArgs);
    }

    const activeSession = SessionState.registry.get(sessionId);

    const sessionDb =
      activeSession?.db ??
      new SessionDb(dataLocation, sessionId, {
        readonly: true,
        fileMustExist: true,
      });

    const session = sessionDb.session.get();
    const related = sessionsDb.findRelatedSessions(session);

    return {
      ...related,
      dataLocation,
      sessionDb,
      sessionState: activeSession,
    };
  }
}
