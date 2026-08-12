declare module 'virtual:smrt-workbench/project' {
  import type {
    SmrtWorkbenchModule,
    SmrtWorkbenchProject,
  } from '@happyvertical/smrt-workbench';
  import type { SmrtPlaygroundModule } from '@happyvertical/smrt-playground';

  export const workbenchProject: SmrtWorkbenchProject;
  export const workbenchModules: SmrtWorkbenchModule[];
  export const playgroundModules: SmrtPlaygroundModule[];
}
