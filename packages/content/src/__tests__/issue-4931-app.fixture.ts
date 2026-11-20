/** Runtime app replacements, dynamically imported after their package models. */
import { smrt } from '@happyvertical/smrt-core';
import { Content as SmrtContent } from '../content.js';

const Content: typeof SmrtContent = class Content extends SmrtContent {};
smrt({ replaceParent: true, packageName: '@local/issue4931-content' })(Content);

// One object, not a named export per class: an export under a model's name
// must be that model, and these replacements are other classes of that name.
export const appModels = { Content };
