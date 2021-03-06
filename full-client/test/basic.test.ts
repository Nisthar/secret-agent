import { Helpers } from '@secret-agent/testing';
import Chrome80 from '@secret-agent/emulate-chrome-80';
import SecretAgent from '../index';

let koaServer;
beforeAll(async () => {
  await SecretAgent.start();
  koaServer = await Helpers.runKoaServer();
});
afterAll(Helpers.afterAll);
afterEach(Helpers.afterEach);

describe('basic Full Client tests', () => {
  it('runs goto', async () => {
    const exampleUrl = `${koaServer.baseUrl}/`;
    const browser = await SecretAgent.createBrowser();

    await browser.goto(exampleUrl);
    const url = await browser.document.location.host;
    expect(url).toBe(koaServer.baseHost);
  });

  it('runs goto with no document loaded', async () => {
    const browser = await SecretAgent.createBrowser();
    const url = await browser.document.location.host;
    expect(url).toBe(null);
  });

  it('gets the resource back from a goto', async () => {
    const exampleUrl = `${koaServer.baseUrl}/`;
    const browser = await SecretAgent.createBrowser({
      emulatorId: Chrome80.emulatorId,
    });

    const resource = await browser.goto(exampleUrl);

    const { request, response } = resource;
    expect(await request.headers).toMatchObject({
      Host: koaServer.baseHost,
      Connection: 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': expect.any(String),
      Accept: expect.any(String),
      'Accept-Encoding': 'gzip, deflate',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    expect(await request.url).toBe(exampleUrl);
    expect(await request.timestamp).toBeTruthy();
    expect(await request.method).toBe('GET');
    expect(await request.postData).toBe('');

    expect(await response.headers).toMatchObject({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': expect.any(String),
      Date: expect.any(String),
      Connection: 'keep-alive',
    });
    expect(await response.url).toBe(exampleUrl);
    expect(await response.timestamp).toBeTruthy();
    expect(await response.remoteAddress).toBeTruthy();
    expect(await response.statusCode).toBe(200);
    expect(await response.statusMessage).toBe('OK');
    expect(await response.text()).toMatch('<h1>Example Domain</h1>');
  });
});
