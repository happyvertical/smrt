/** Runtime app replacements, dynamically imported after their package models. */
import { smrt } from '@happyvertical/smrt-core';
import { Issue as SmrtIssue } from '../models/Issue.js';
import { PullRequest as SmrtPullRequest } from '../models/PullRequest.js';

const Issue: typeof SmrtIssue = class Issue extends SmrtIssue {};
smrt({ replaceParent: true, packageName: '@local/issue4931-projects' })(Issue);

const PullRequest: typeof SmrtPullRequest = class PullRequest extends SmrtPullRequest {};
smrt({ replaceParent: true, packageName: '@local/issue4931-projects' })(
  PullRequest,
);

// One object, not a named export per class: an export under a model's name
// must be that model, and these replacements are other classes of that name.
export const appModels = { Issue, PullRequest };
