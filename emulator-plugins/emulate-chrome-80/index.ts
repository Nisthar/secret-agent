import Emulators, {
  EmulatorPlugin,
  EmulatorPluginStatics,
  UserAgents,
} from '@secret-agent/emulators';
import IHttpRequestModifierDelegate from '@secret-agent/commons/interfaces/IHttpRequestModifierDelegate';
import {
  chromePageOverrides,
  getEngineExecutablePath,
  modifyHeaders,
  readPolyfills,
  tcpVars,
} from '@secret-agent/emulator-plugins-shared';
import { randomBytes } from 'crypto';
import { pickRandom } from '@secret-agent/emulators/lib/Utils';
import IUserAgent from '@secret-agent/emulators/interfaces/IUserAgent';
import { ConnectionOptions } from 'tls';
import navigator from './navigator.json';
import chrome from './chrome.json';
import codecs from './codecs.json';
import pkg from './package.json';
import headerProfiles from './headers.json';
import defaultUseragents from './user-agents.json';
import frame from './frame.json';

const polyfills = readPolyfills(__dirname);
const engineExecutablePath = process.env.CHROME_80_BIN ?? getEngineExecutablePath(pkg.engine);

@EmulatorPluginStatics
export default class Chrome80 extends EmulatorPlugin {
  public static emulatorId = pkg.name;
  public static statcounterBrowser = 'Chrome 80.0';
  public static engine = pkg.engine;
  public static dnsOverTlsConnectOptions = <ConnectionOptions>{
    host: '1.1.1.1',
    servername: 'cloudflare-dns.com',
  };

  protected static agents = UserAgents.getList(
    {
      deviceCategory: 'desktop',
      vendor: 'Google Inc.',
      family: 'Chrome',
      versionMajor: 80,
      operatingSystems: [
        {
          family: 'Windows',
        },
        {
          family: 'Mac OS X',
        },
      ],
    },
    defaultUseragents,
  );

  protected static polyfills = readPolyfills(__dirname);

  public engine = pkg.engine;

  public get engineExecutablePath() {
    return engineExecutablePath;
  }

  public get canPolyfill() {
    return polyfills?.canPolyfill(this);
  }

  public readonly userAgent: IUserAgent;
  public delegate: IHttpRequestModifierDelegate;

  constructor(userAgent?: IUserAgent) {
    super();
    this.userAgent = userAgent ?? pickRandom(Chrome80.agents);
    this.delegate = {
      modifyHeadersBeforeSend: modifyHeaders.bind(this, this.userAgent, headerProfiles),
      tlsProfileId: 'Chrome80',
      tcpVars: tcpVars(this.userAgent.os),
      dnsOverTlsConnectOptions: Chrome80.dnsOverTlsConnectOptions,
    };
  }

  public async generatePageOverrides() {
    const os = this.userAgent.os;
    const osFamilyLower = os.family.match(/mac/i) ? 'mac-os-x' : 'windows';
    const windowFrame = frame[osFamilyLower] ?? frame[`${osFamilyLower}-${os.major}`];

    const args = {
      osFamily: os.family,
      osVersion: `${os.major}.${os.minor}`,
      platform: this.userAgent.platform,
      memory: Math.ceil(Math.random() * 4) * 2,
      languages: ['en-US', 'en'],
      windowFrame,
      videoDevice: {
        // TODO: stabilize per user
        deviceId: randomBytes(32).toString('hex'),
        groupId: randomBytes(32).toString('hex'),
      },
    };

    // import scripts from single file
    return chromePageOverrides(args, {
      codecs,
      chrome,
      polyfills: polyfills.get(this),
      navigator,
    });
  }
}
Emulators.load(Chrome80);
