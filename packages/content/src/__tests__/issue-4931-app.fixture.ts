/** Runtime app replacements, dynamically imported after their package models. */
import { smrt } from '@happyvertical/smrt-core';
import { Content as SmrtContent } from '../content.js';

export const Content: typeof SmrtContent = class Content extends SmrtContent {};
smrt({ packageName: '@local/issue4931-content' })(Content);
