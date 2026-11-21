/** Runtime app replacements, dynamically imported after their package models. */
import { smrt } from '@happyvertical/smrt-core';
import { Issue as SmrtIssue } from '../models/Issue.js';
import { PullRequest as SmrtPullRequest } from '../models/PullRequest.js';

export const Issue: typeof SmrtIssue = class Issue extends SmrtIssue {};
smrt({ replaceParent: true, packageName: '@local/issue4931-projects' })(Issue);

export const PullRequest: typeof SmrtPullRequest = class PullRequest extends SmrtPullRequest {};
smrt({ replaceParent: true, packageName: '@local/issue4931-projects' })(
  PullRequest,
);
