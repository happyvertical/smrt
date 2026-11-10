import { SmrtCollection } from '@happyvertical/smrt-core';
import { Poll } from '../models/Poll.js';
import { PollVote } from '../models/PollVote.js';
import { Reaction } from '../models/Reaction.js';
export class ReactionCollection extends SmrtCollection<Reaction> {
  static readonly _itemClass = Reaction;
}
export class PollCollection extends SmrtCollection<Poll> {
  static readonly _itemClass = Poll;
}
export class PollVoteCollection extends SmrtCollection<PollVote> {
  static readonly _itemClass = PollVote;
}
