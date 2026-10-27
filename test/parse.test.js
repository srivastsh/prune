import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFollowingPage, parseV1FriendsList, parseV1Lookup, parseUserTweets, missingFeaturesFromError,
  scrapeOperations, bucketOf, snowflakeToMs, toCSV, relTime,
} from '../src/lib/parse.js';

const DAY = 86400000;
const NOW = Date.parse('2026-10-26T12:00:00Z');
const ago = (d) => new Date(NOW - d * DAY).toUTCString().replace('GMT', '+0000');

// Shape mirrors X's GraphQL Following response, including the 2025 move of
// screen_name/name into `core` and a legacy-shaped user for older bundles.
const followingFixture = {
  data: { user: { result: { timeline: { timeline: { instructions: [
    { type: 'TimelineClearCache' },
    { type: 'TimelineAddEntries', entries: [
      { entryId: 'user-1', content: { itemContent: { user_results: { result: {
        __typename: 'User', rest_id: '1', core: { screen_name: 'alice', name: 'Alice', created_at: 'Wed Oct 10 20:19:24 +0000 2018' },
        avatar: { image_url: 'https://pbs.twimg.com/a.jpg' }, legacy: { statuses_count: 50, followers_count: 1200, description: 'hi' },
        relationship_perspectives: { followed_by: true }, privacy: { protected: false },
      } } } } },
      { entryId: 'user-2', content: { itemContent: { user_results: { result: {
        __typename: 'User', rest_id: '2', legacy: { screen_name: 'bob', name: 'Bob', statuses_count: 0, followers_count: 3, protected: true },
      } } } } },
      { entryId: 'user-3', content: { itemContent: { user_results: { result: { __typename: 'UserUnavailable', rest_id: '3', reason: 'Suspended' } } } } },
      { entryId: 'cursor-top-1', content: { value: 'TOP', cursorType: 'Top' } },
      { entryId: 'cursor-bottom-1', content: { value: 'NEXT123', cursorType: 'Bottom' } },
    ] },
  ] } } } } },
};

test('parseFollowingPage handles core + legacy shapes and cursors', () => {
  const { users, nextCursor } = parseFollowingPage(followingFixture);
  assert.equal(nextCursor, 'NEXT123');
  assert.equal(users.length, 3);
  const [a, b, c] = users;
  assert.equal(a.handle, 'alice');
  assert.equal(a.followsYou, true);
  assert.equal(a.avatar, 'https://pbs.twimg.com/a.jpg');
  assert.equal(b.handle, 'bob');
  assert.equal(b.statuses, 0);
  assert.equal(b.protected, true);
  assert.equal(c.unavailable, true);
});

test('parseFollowingPage ends on an empty page', () => {
  const empty = { data: { user: { result: { timeline: { timeline: { instructions: [
    { type: 'TimelineAddEntries', entries: [{ entryId: 'cursor-bottom-0', content: { value: 'X' } }] },
  ] } } } } } };
  assert.deepEqual(parseFollowingPage(empty), { users: [], nextCursor: null });
});

test('v1 friends/list includes last post and cursor', () => {
  const j = {
    users: [
      { id_str: '10', screen_name: 'carol', name: 'Carol', statuses_count: 9, followers_count: 5, status: { created_at: ago(45), id_str: '111' } },
      { id_str: '11', screen_name: 'dan', name: 'Dan', statuses_count: 0 },
    ],
    next_cursor_str: '0',
  };
  const { users, nextCursor } = parseV1FriendsList(j);
  assert.equal(nextCursor, null);
  assert.equal(bucketOf(users[0], NOW), 'd60');
  assert.equal(users[1].never, true);
  assert.equal(bucketOf(users[1], NOW), 'never');
});

test('v1 lookup', () => {
  const recs = parseV1Lookup([{ id_str: '5', screen_name: 'e', statuses_count: 3, status: { created_at: ago(200), id_str: '9' } }]);
  assert.equal(bucketOf(recs[0], NOW), 'dead');
});

test('parseUserTweets picks newest own post, counts pinned, respects reposts flag', () => {
  const tw = (id, days, extra = {}) => ({
    tweet_results: { result: { __typename: 'Tweet', rest_id: id, core: { user_results: { result: { rest_id: '42' } } },
      legacy: { created_at: ago(days), user_id_str: '42', ...extra } } },
  });
  const quoted = { tweet_results: { result: { rest_id: 'q', core: { user_results: { result: { rest_id: '99' } } }, legacy: { created_at: ago(1), user_id_str: '99' } } } };
  const json = { data: { user: { result: { timeline_v2: { timeline: { instructions: [
    { type: 'TimelinePinEntry', entry: { content: { itemContent: tw('p', 400) } } },
    { type: 'TimelineAddEntries', entries: [
      { content: { itemContent: tw('r', 10, { retweeted_status_result: { result: {} } }) } },
      { content: { itemContent: { ...tw('a', 70), quoted } } },
      { content: { itemContent: tw('b', 120) } },
    ] },
  ] } } } } } };
  const withReposts = parseUserTweets(json, '42');
  assert.equal(withReposts.lastPostId, 'r');
  const noReposts = parseUserTweets(json, '42', { countReposts: false });
  assert.equal(noReposts.lastPostId, 'a');
  assert.equal(bucketOf({ lastPostAt: noReposts.lastPostAt }, NOW), 'd90');
});

test('TweetWithVisibilityResults wrapper is unwrapped', () => {
  const json = { x: { tweet_results: { result: { __typename: 'TweetWithVisibilityResults', tweet: { rest_id: '7', legacy: { created_at: ago(3), user_id_str: '1' } } } } } };
  assert.equal(parseUserTweets(json, '1').lastPostId, '7');
});

test('missing feature errors are parsed', () => {
  const j = { errors: [{ message: 'The following features cannot be null: foo_enabled, bar_enabled' }] };
  assert.deepEqual(missingFeaturesFromError(j), ['foo_enabled', 'bar_enabled']);
});

test('scrapeOperations reads query ids and feature switches from a bundle', () => {
  const js = 'e.exports={queryId:"AbC-12_x",operationName:"Following",operationType:"query",metadata:{featureSwitches:["a_b","c_d"],fieldToggles:[]}};' +
    'e.exports={queryId:"ZZ9",operationName:"UserTweets",operationType:"query",metadata:{featureSwitches:[]}}';
  const ops = scrapeOperations(js, ['Following', 'UserTweets', 'Missing']);
  assert.equal(ops.Following.queryId, 'AbC-12_x');
  assert.deepEqual(ops.Following.features, ['a_b', 'c_d']);
  assert.equal(ops.UserTweets.queryId, 'ZZ9');
  assert.equal(ops.Missing, undefined);
});

test('bucket boundaries', () => {
  assert.equal(bucketOf({ lastPostAt: NOW - 30 * DAY }, NOW), 'active');
  assert.equal(bucketOf({ lastPostAt: NOW - 31 * DAY }, NOW), 'd60');
  assert.equal(bucketOf({ lastPostAt: NOW - 60 * DAY }, NOW), 'd60');
  assert.equal(bucketOf({ lastPostAt: NOW - 61 * DAY }, NOW), 'd90');
  assert.equal(bucketOf({ lastPostAt: NOW - 91 * DAY }, NOW), 'dead');
  assert.equal(bucketOf({}, NOW), 'unknown');
  assert.equal(bucketOf({ unavailable: true }, NOW), 'gone');
});

test('snowflake timestamps', () => {
  // 1849510000000000000 >> 22 + epoch ≈ late 2024
  const ms = snowflakeToMs('1849510000000000000');
  assert.ok(ms > Date.parse('2024-01-01') && ms < Date.parse('2026-01-01'));
  assert.equal(snowflakeToMs('not a number'), null);
});

test('CSV escapes and relTime reads well', () => {
  const csv = toCSV([{ handle: 'x', name: 'A, "B"', id: '1', lastPostAt: NOW - 100 * DAY, followers: 1, statuses: 2 }], NOW);
  assert.match(csv.split('\n')[1], /^x,"A, ""B""",1,dead,100,/);
  assert.equal(relTime(NOW - 2 * DAY, NOW), '2 days ago');
  assert.equal(relTime(NOW - 400 * DAY, NOW), '13 months ago');
  assert.equal(relTime(NOW - 1000 * DAY, NOW), '2.7 years ago');
});
