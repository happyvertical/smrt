import { describe, expect, it } from 'vitest';
import * as models from './index.js';
import * as server from './server.js';

describe('package entry boundaries', () => {
  it('keeps the owned runtime on the server entry and preserves model identity', () => {
    expect(Object.keys(models).sort()).toEqual(
      [
        'Poll',
        'PollCollection',
        'PollVote',
        'PollVoteCollection',
        'REACTION_KINDS',
        'Reaction',
        'ReactionCollection',
      ].sort(),
    );
    expect(typeof server.ParticipationRuntime.create).toBe('function');
    expect(server.Poll).toBe(models.Poll);
    expect(server.PollVote).toBe(models.PollVote);
    expect(server.Reaction).toBe(models.Reaction);
  });
});
