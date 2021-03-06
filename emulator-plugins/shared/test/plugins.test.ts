import * as Helpers from '@secret-agent/testing/helpers';
import navigatorJson from '@secret-agent/emulate-chrome-80/navigator.json';
import { inspect } from 'util';
import Puppet from '@secret-agent/puppet';
import Core from '@secret-agent/core';
import Emulators from '@secret-agent/emulators';
import Log from '@secret-agent/commons/Logger';
import chrome80Dom from './chrome80DomProperties.json';
import inspectScript from './inspectHierarchy';
import { getOverrideScript } from '../injected-scripts';

const { log } = Log(module);

const { navigator } = navigatorJson;

let puppet: Puppet;
beforeAll(async () => {
  const emulator = Emulators.create(Core.defaultEmulatorId);
  puppet = new Puppet(emulator);
  Helpers.onClose(() => puppet.close(), true);
  puppet.start();
});

afterAll(Helpers.afterAll);
afterEach(Helpers.afterEach);

const debug = process.env.DEBUG || false;

test('it should override plugins in a browser window', async () => {
  const httpServer = await Helpers.runHttpServer();

  const context = await puppet.newContext(
    {
      proxyPassword: '',
      platform: 'win32',
      acceptLanguage: 'en',
      userAgent: 'Plugin Test',
    },
    log,
  );
  Helpers.onClose(() => context.close());
  const page = await context.newPage();

  page.on('page-error', console.log);
  if (debug) {
    page.on('console', console.log);
  }
  await page.addNewDocumentScript(
    getOverrideScript('plugins', {
      mimeTypes: [
        {
          type: 'application/pdf',
          suffixes: 'pdf',
          description: '',
          __pluginName: 'Chrome PDF Viewer',
        },
        {
          type: 'application/x-google-chrome-pdf',
          suffixes: 'pdf',
          description: 'Portable Document Format',
          __pluginName: 'Chrome PDF Plugin',
        },
        {
          type: 'application/x-nacl',
          suffixes: '',
          description: 'Native Client Executable',
          __pluginName: 'Native Client',
        },
        {
          type: 'application/x-pnacl',
          suffixes: '',
          description: 'Portable Native Client Executable',
          __pluginName: 'Native Client',
        },
      ],
      plugins: [
        {
          name: 'Chrome PDF Plugin',
          filename: 'internal-pdf-viewer',
          description: 'Portable Document Format',
        },
        {
          name: 'Chrome PDF Viewer',
          filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
          description: '',
        },
        {
          name: 'Native Client',
          filename: 'internal-nacl-plugin',
          description: '',
        },
      ],
    }).script,
    false,
  );
  await Promise.all([
    page.navigate(httpServer.url),
    page.waitOn('frame-lifecycle', ev => ev.name === 'DOMContentLoaded'),
  ]);

  const hasPlugins = await page.mainFrame.evaluate(
    `'plugins' in navigator && 'mimeTypes' in navigator`,
    false,
  );
  expect(hasPlugins).toBe(true);

  const pluginCount = await page.mainFrame.evaluate(`navigator.plugins.length`, false);
  expect(pluginCount).toBe(3);

  const mimecount = await page.mainFrame.evaluate(`navigator.mimeTypes.length`, false);
  expect(mimecount).toBe(4);

  const structure = JSON.parse(
    (await page.mainFrame.evaluate(
      `(${inspectScript.toString()})(window, 'window',  ['Plugin', 'PluginArray', 'MimeType', 'MimeTypeArray','navigator'])`,
      false,
    )) as any,
  ).window;
  for (const proto of ['Plugin', 'PluginArray', 'MimeType', 'MimeTypeArray']) {
    if (debug) console.log(inspect(structure[proto], false, null, true));
    expect(structure[proto]).toStrictEqual(chrome80Dom[proto]);
  }
  const navigatorStructure = structure.navigator;
  if (debug) console.log(inspect(navigatorStructure.mimeTypes, false, null, true));
  expect(navigatorStructure.mimeTypes).toStrictEqual(navigator.mimeTypes);

  if (debug) console.log(inspect(navigatorStructure.plugins, false, null, true));
  expect(navigatorStructure.plugins).toStrictEqual(navigator.plugins);
}, 60e3);
