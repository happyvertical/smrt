// Self-register this package's manifest for consumers that import this subpath
// without the main entry (#1132): ConnectState must not register field-less.
import '../__smrt-register__.js';

export { ConnectStateCollection } from '../collections/ConnectStateCollection.js';
export {
  ConnectState,
  type ConnectStateOptions,
} from '../models/ConnectState.js';
export {
  buildOAuth2AuthorizeUrl,
  discoverOidcEndpoints,
  exchangeOAuth2Code,
  fetchOidcUserInfo,
  type OAuth2AuthorizeRequest,
  type OAuth2Endpoints,
  type OAuth2ProviderConfig,
  type OidcUserInfo,
} from './oauth.js';
export {
  type BeginConnectOptions,
  type BegunConnect,
  beginConnect,
  type ConsumeConnectOptions,
  type ConsumedConnect,
  consumeConnect,
  DEFAULT_CONNECT_STATE_TTL_MS,
  generateCodeChallenge,
  generateCodeVerifier,
  generateConnectState,
  isSafeReturnPath,
} from './state.js';
export {
  ConnectError,
  type ConnectErrorCode,
  type ConnectStateRecord,
  type ConnectStateStore,
  type NewConnectState,
  type OAuthClientCredentials,
  type OAuthTokenSet,
} from './types.js';
