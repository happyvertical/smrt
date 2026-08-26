import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import type {
  RegisterWebMcpToolsOptions,
  SmrtWebClient,
  SmrtWebCollectionDefinition,
} from '@happyvertical/smrt-web';

export interface WebMcpUiProviderConfig {
  controlRegistry?: ControlInteractionRegistry;
  dataSurfaceRegistry?: DataSurfaceRegistry;
  /** Document-global namespace prefix. @default 'smrt_ui_' */
  prefix?: string;
}

export interface WebMcpProviderConfig {
  definitions?: SmrtWebCollectionDefinition[];
  client?: SmrtWebClient;
  basePath?: string;
  fetchFn?: typeof fetch;
  scope?: string;
  filter?: RegisterWebMcpToolsOptions['filter'];
  /** Fixed browser-native tools over the mounted form/data registries. */
  ui?: false | WebMcpUiProviderConfig;
}
