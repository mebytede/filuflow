// Parameters of the Slack node (typeVersion 2 to 2.4) like n8n-nodes-base 1.121.0 nodes/Slack/V2/SlackV2.node.js
// (authentication, resource, send and wait via utils/sendAndWait/utils.js getSendAndWaitProperties without "Subject"),
// ChannelDescription.js, MessageDescription.js, StarDescription.js, FileDescription.js, ReactionDescription.js,
// UserDescription.js and UserGroupDescription.js. Names, defaults, options and visibility rules as in the reference;
// labels as in the reference, descriptions are filuflow's own.
// Differences in the description only:
// - "Attachments" of message:post is a collection with several entries in the reference; the form edits it as a JSON list
//   (the stored value stays the same list of attachment objects, see docs/DECISIONS.md).
// - Hints ("hint") are part of the description; links to the reference documentation are left out.
import type { ParamSchema, ResourceLocatorMode } from '../params.js';
import { sendAndWaitProperties } from './sendAndWaitParams.js';

const opts = (...pairs: Array<[string, string]>) => pairs.map(([value, label]) => ({ value, label }));
const on = (resource: string, ...operation: string[]) => ({ resource: [resource], operation });

const getUsers = { method: 'getUsers' };
const getChannels = { method: 'getChannels' };

// -------------------------------------------------------------------------------------------------------------------
// Resource locators (MessageDescription.js channelRLC, userRLC)
// -------------------------------------------------------------------------------------------------------------------

const ID_PATTERN = '[a-zA-Z0-9]{2,}';

const channelModes = (withName: boolean): ResourceLocatorMode[] => [
  { name: 'list', label: 'From List', type: 'list', placeholder: 'Select a channel...', searchListMethod: 'getChannels', searchable: true },
  { name: 'id', label: 'By ID', type: 'string', placeholder: 'C0122KQ70S7E', validation: [{ regex: ID_PATTERN, errorMessage: 'Not a valid Slack Channel ID' }] },
  ...(withName ? [{ name: 'name', label: 'By Name', type: 'string' as const, placeholder: '#general' }] : []),
  {
    name: 'url',
    label: 'By URL',
    type: 'string',
    placeholder: 'https://app.slack.com/client/TS9594PZK/B0556F47Z3A',
    validation: [{ regex: 'http(s)?://app.slack.com/client/.*/([a-zA-Z0-9]{2,})', errorMessage: 'Not a valid Slack Channel URL' }],
    extractValue: { regex: 'https://app.slack.com/client/.*/([a-zA-Z0-9]{2,})' },
  },
];

const userModes = (withUsername: boolean): ResourceLocatorMode[] => [
  { name: 'list', label: 'From List', type: 'list', placeholder: 'Select a user...', searchListMethod: 'getUsers', searchable: true },
  { name: 'id', label: 'By ID', type: 'string', placeholder: 'U123AB45JGM', validation: [{ regex: ID_PATTERN, errorMessage: 'Not a valid Slack User ID' }] },
  ...(withUsername ? [{ name: 'username', label: 'By username', type: 'string' as const, placeholder: '@username' }] : []),
];

const channelLocator = (show: ParamSchema['show'], description: string | undefined, o: { withName?: boolean; required?: boolean } = {}): ParamSchema => ({
  name: 'channelId',
  label: 'Channel',
  type: 'resourceLocator',
  default: { mode: 'list', value: '' },
  placeholder: 'Select a channel...',
  ...(o.required === false ? {} : { required: true }),
  ...(description ? { description } : {}),
  modes: channelModes(o.withName ?? false),
  show,
});

const userLocator = (show: ParamSchema['show'], description: string | undefined, withUsername: boolean, required = false): ParamSchema => ({
  name: 'user',
  label: 'User',
  type: 'resourceLocator',
  default: { mode: 'list', value: '' },
  placeholder: 'Select a user...',
  ...(required ? { required: true } : {}),
  ...(description ? { description } : {}),
  modes: userModes(withUsername),
  show,
});

const returnAllParam = (show: ParamSchema['show']): ParamSchema => ({
  name: 'returnAll',
  label: 'Return All',
  type: 'boolean',
  default: false,
  description: 'Whether every result is returned or only up to the limit',
  show,
});

const limitParam = (show: ParamSchema['show'], defaultValue: number, max?: number): ParamSchema => ({
  name: 'limit',
  label: 'Limit',
  type: 'number',
  default: defaultValue,
  min: 1,
  ...(max ? { max } : {}),
  description: 'Upper limit of results',
  show: { ...show, returnAll: [false] },
});

const timestampParam = (name: string, show: ParamSchema['show'], description: string, required = true): ParamSchema => ({
  name,
  label: 'Message Timestamp',
  type: 'number',
  ...(required ? { required: true } : {}),
  placeholder: '1663233118.856619',
  description,
  show,
});

const includeCount: ParamSchema = { name: 'include_count', label: 'Include Count', type: 'boolean', default: true, description: 'Whether the number of users of each user group is included' };

// -------------------------------------------------------------------------------------------------------------------
// Channel (ChannelDescription.js)
// -------------------------------------------------------------------------------------------------------------------

const historyFilters = (dateType: 'dateTime' | 'string'): ParamSchema[] => [
  { name: 'inclusive', label: 'Inclusive', type: 'boolean', default: false, description: 'Whether messages exactly at the latest or oldest timestamp are included (only with one of them set)' },
  { name: 'latest', label: 'Latest', type: dateType, default: '', description: 'End of the time range of the messages' },
  { name: 'oldest', label: 'Oldest', type: dateType, default: '', description: 'Start of the time range of the messages' },
];

const channelParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'create',
    show: { resource: ['channel'] },
    options: [
      { value: 'archive', label: 'Archive', description: 'Archive a conversation' },
      { value: 'close', label: 'Close', description: 'Close a direct message or multi-person direct message' },
      { value: 'create', label: 'Create', description: 'Start a public or private channel' },
      { value: 'get', label: 'Get', description: 'Get information about a channel' },
      { value: 'getAll', label: 'Get Many', description: 'Get many channels of the workspace' },
      { value: 'history', label: 'History', description: 'Get the messages and events of a conversation' },
      { value: 'invite', label: 'Invite', description: 'Invite users to a channel' },
      { value: 'join', label: 'Join', description: 'Join an existing conversation' },
      { value: 'kick', label: 'Kick', description: 'Remove a user from a channel' },
      { value: 'leave', label: 'Leave', description: 'Leave a conversation' },
      { value: 'member', label: 'Member', description: 'List the members of a conversation' },
      { value: 'open', label: 'Open', description: 'Open or resume a direct message or multi-person direct message' },
      { value: 'rename', label: 'Rename', description: 'Rename a conversation' },
      { value: 'replies', label: 'Replies', description: 'Get the thread of a message in a channel' },
      { value: 'setPurpose', label: 'Set Purpose', description: 'Set the purpose of a conversation' },
      { value: 'setTopic', label: 'Set Topic', description: 'Set the topic of a conversation' },
      { value: 'unarchive', label: 'Unarchive', description: 'Unarchive a conversation' },
    ],
  },
  channelLocator(on('channel', 'archive'), 'The channel to archive', { required: false }),
  channelLocator(on('channel', 'close'), 'The channel to close'),
  { name: 'channelId', label: 'Channel', type: 'string', default: '', placeholder: 'Channel name', required: true, show: on('channel', 'create') },
  {
    name: 'channelVisibility',
    label: 'Channel Visibility',
    type: 'options',
    default: 'public',
    required: true,
    description: 'Whether the new channel is public or private',
    options: opts(['public', 'Public Channel'], ['private', 'Private Channel']),
    show: on('channel', 'create'),
  },
  channelLocator(on('channel', 'invite'), 'The channel to invite the users to'),
  { name: 'userIds', label: 'User Names or IDs', type: 'multiOptions', loadOptions: getUsers, default: [], required: true, description: 'Users to invite into the channel; pick them or give IDs with an expression', show: on('channel', 'invite') },
  channelLocator(on('channel', 'get'), 'The channel to get'),
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add Field',
    addLabel: 'Add Field',
    show: on('channel', 'get'),
    children: [{ name: 'includeNumMembers', label: 'Include Num of Members', type: 'boolean', default: false }],
  },
  channelLocator(on('channel', 'kick'), 'The channel to remove the user from'),
  { name: 'userId', label: 'User Name or ID', type: 'options', loadOptions: getUsers, default: '', description: 'Pick a user or give an ID with an expression', show: on('channel', 'kick') },
  channelLocator(on('channel', 'join'), 'The channel to join'),
  returnAllParam(on('channel', 'getAll')),
  limitParam(on('channel', 'getAll'), 50, 100),
  {
    name: 'filters',
    label: 'Filters',
    type: 'collection',
    default: {},
    placeholder: 'Add Field',
    addLabel: 'Add Field',
    show: on('channel', 'getAll'),
    children: [
      { name: 'excludeArchived', label: 'Exclude Archived', type: 'boolean', default: false, description: 'Whether archived channels are left out' },
      {
        name: 'types',
        label: 'Types',
        type: 'multiOptions',
        default: ['public_channel'],
        description: 'Kinds of conversations to list',
        options: opts(['public_channel', 'Public Channel'], ['private_channel', 'Private Channel'], ['mpim', 'mpim'], ['im', 'im']),
      },
    ],
  },
  channelLocator(on('channel', 'history'), 'The channel to get the history of'),
  returnAllParam(on('channel', 'history')),
  limitParam(on('channel', 'history'), 50, 100),
  { name: 'filters', label: 'Filters', type: 'collection', default: {}, placeholder: 'Add Field', addLabel: 'Add Field', show: on('channel', 'history'), children: historyFilters('dateTime') },
  channelLocator(on('channel', 'leave'), 'The channel to leave'),
  channelLocator(on('channel', 'member'), 'The channel to list the members of'),
  returnAllParam(on('channel', 'member')),
  { name: 'limit', label: 'Limit', type: 'number', default: 100, min: 1, placeholder: 'Limit', description: 'Upper limit of results', show: { ...on('channel', 'member'), returnAll: [false] } },
  { name: 'resolveData', label: 'Resolve Data', type: 'boolean', default: false, description: 'Whether the full user is returned for every member instead of the ID only', show: on('channel', 'member') },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add Field',
    addLabel: 'Add Field',
    show: on('channel', 'open'),
    children: [
      { name: 'channelId', label: 'Channel ID', type: 'string', default: '', description: 'ID of a direct message (im or mpim) to resume; or give the users instead' },
      { name: 'returnIm', label: 'Return IM', type: 'boolean', default: false, description: 'Whether the full definition of the direct message is returned' },
      {
        name: 'users',
        label: 'User Names or IDs',
        type: 'multiOptions',
        loadOptions: getUsers,
        default: [],
        description: 'One user opens a 1:1 direct message, several a multi-person direct message (in this order); give a channel instead when no users are set',
      },
    ],
  },
  channelLocator(on('channel', 'rename'), 'The channel to rename'),
  { name: 'name', label: 'Name', type: 'string', default: '', required: true, description: 'New name of the conversation', show: on('channel', 'rename') },
  channelLocator(on('channel', 'replies'), 'The channel of the thread'),
  timestampParam('ts', on('channel', 'replies'), 'Timestamp of the message whose thread is returned'),
  returnAllParam(on('channel', 'replies')),
  limitParam(on('channel', 'replies'), 50, 100),
  { name: 'filters', label: 'Filters', type: 'collection', default: {}, placeholder: 'Add Field', addLabel: 'Add Field', show: on('channel', 'replies'), children: historyFilters('string') },
  channelLocator(on('channel', 'setPurpose'), 'The channel to set the purpose of'),
  { name: 'purpose', label: 'Purpose', type: 'string', default: '', required: true, description: 'The new purpose', show: on('channel', 'setPurpose') },
  channelLocator(on('channel', 'setTopic'), 'The channel to set the topic of'),
  { name: 'topic', label: 'Topic', type: 'string', default: '', required: true, show: on('channel', 'setTopic') },
  channelLocator(on('channel', 'unarchive'), 'The channel to unarchive'),
];

// -------------------------------------------------------------------------------------------------------------------
// Message (MessageDescription.js)
// -------------------------------------------------------------------------------------------------------------------

const sendToSelector = (show: ParamSchema['show'], label: string, defaultValue: string): ParamSchema => ({
  name: 'select',
  label,
  type: 'options',
  required: true,
  default: defaultValue,
  placeholder: 'Select...',
  options: opts(['channel', 'Channel'], ['user', 'User']),
  show,
});

const messageTypeParam = (operation: string): ParamSchema => ({
  name: 'messageType',
  label: 'Message Type',
  type: 'options',
  default: 'text',
  description: 'A simple text message, Slack blocks (buttons, sections, form elements and more) or legacy attachments',
  options: [
    { value: 'text', label: 'Simple Text Message', description: 'Supports basic Markdown' },
    { value: 'block', label: 'Blocks', description: 'Text, buttons, form elements, dividers and more from the Block Kit Builder' },
    { value: 'attachment', label: 'Attachments' },
  ],
  show: on('message', operation),
});

const blocksParam = (operation: string): ParamSchema => ({
  name: 'blocksUi',
  label: 'Blocks',
  type: 'string',
  default: '',
  required: true,
  rows: 3,
  description: "JSON from Slack's Block Kit Builder (app.slack.com/block-kit-builder); expressions can add variable content",
  show: { ...on('message', operation), messageType: ['block'] },
});

const notificationTextParam = (operation: string): ParamSchema => ({
  name: 'text',
  label: 'Notification Text',
  type: 'string',
  default: '',
  description: 'Fallback text shown in notifications; Slack Markdown unless switched off in the options',
  show: { ...on('message', operation), messageType: ['block'] },
});

const includeLinkParam: ParamSchema = {
  name: 'includeLinkToWorkflow',
  label: 'Include Link to Workflow',
  type: 'boolean',
  default: true,
  description: 'Whether a link to this workflow is appended to the message. filuflow keeps the setting but appends nothing.',
};

const attachmentChildren: ParamSchema[] = [
  { name: 'fallback', label: 'Fallback Text', type: 'string', default: '', description: 'Plain text summary of the attachment (required by Slack)' },
  { name: 'text', label: 'Text', type: 'string', default: '' },
  { name: 'title', label: 'Title', type: 'string', default: '' },
  { name: 'title_link', label: 'Title Link', type: 'string', default: '' },
  { name: 'color', label: 'Color', type: 'color', default: '#ff0000', description: 'Color of the bar left of the text' },
  { name: 'pretext', label: 'Pretext', type: 'string', default: '', description: 'Text above the attachment' },
  { name: 'author_name', label: 'Author Name', type: 'string', default: '', description: 'Name shown as the author' },
  { name: 'author_link', label: 'Author Link', type: 'string', default: '' },
  { name: 'author_icon', label: 'Author Icon', type: 'string', default: '', description: 'Icon shown next to the author' },
  { name: 'image_url', label: 'Image URL', type: 'string', default: '' },
  { name: 'thumb_url', label: 'Thumbnail URL', type: 'string', default: '' },
  { name: 'footer', label: 'Footer', type: 'string', default: '', description: 'Text of the footer' },
  { name: 'footer_icon', label: 'Footer Icon', type: 'string', default: '', description: 'Icon shown next to the footer' },
  { name: 'ts', label: 'Message Timestamp', type: 'number', default: 0, placeholder: '1663233118.856619', description: 'Timestamp shown with the attachment' },
  {
    name: 'fields',
    label: 'Fields',
    type: 'fixedCollection',
    multiple: true,
    default: {},
    placeholder: 'Add Fields',
    addLabel: 'Add Fields',
    description: 'Fields of the attachment',
    groups: [
      {
        name: 'item',
        label: 'Item',
        children: [
          { name: 'title', label: 'Title', type: 'string', default: '' },
          { name: 'value', label: 'Value', type: 'string', default: '' },
          { name: 'short', label: 'Short', type: 'boolean', default: true, description: 'Whether fields may be shown next to each other' },
        ],
      },
    ],
  },
];

const emojiDescription = 'An emoji code such as +1, not the emoji itself';

const postOptions: ParamSchema = {
  name: 'otherOptions',
  label: 'Options',
  type: 'collection',
  default: {},
  placeholder: 'Add option',
  addLabel: 'Add option',
  description: 'Further options of the message',
  show: on('message', 'post'),
  children: [
    includeLinkParam,
    {
      name: 'botProfile',
      label: 'Custom Bot Profile Photo',
      type: 'fixedCollection',
      default: { imageValues: [{ profilePhotoType: '' }] },
      description: 'Image or emoji used as the avatar of the bot (not used when sending as a user)',
      groups: [
        {
          name: 'imageValues',
          label: 'Add Bot Profile Photo',
          children: [
            { name: 'profilePhotoType', label: 'Profile Photo Type', type: 'options', default: '', placeholder: 'Select a type…', options: opts(['image', 'Image URL'], ['emoji', 'Emoji Code']) },
            { name: 'icon_emoji', label: 'Emoji Code', type: 'string', default: '', description: `Only used when sending as a bot. ${emojiDescription}.`, show: { profilePhotoType: ['emoji'] } },
            { name: 'icon_url', label: 'Image URL', type: 'string', default: '', description: 'Only used when sending as a bot', show: { profilePhotoType: ['image'] } },
          ],
        },
      ],
    },
    { name: 'link_names', label: 'Link User and Channel Names', type: 'boolean', default: false, description: 'Whether @users and #channels in the text become links' },
    {
      name: 'thread_ts',
      label: 'Reply to a Message',
      type: 'fixedCollection',
      default: {},
      placeholder: 'Reply to a Message',
      addLabel: 'Reply to a Message',
      description: "Timestamp of another message to reply to it",
      groups: [
        {
          name: 'replyValues',
          label: 'Reply to a Message',
          children: [
            { name: 'thread_ts', label: 'Message Timestamp to Reply To', type: 'number', placeholder: '1663233118.856619', description: 'Slack nodes return the timestamp of a message as ts' },
            { name: 'reply_broadcast', label: 'Also Send to Channel', type: 'boolean', default: false, description: 'Whether the reply is also shown to everyone in the channel or conversation' },
          ],
        },
      ],
    },
    { name: 'mrkdwn', label: 'Use Markdown?', type: 'boolean', default: true, description: 'Whether Slack Markdown formats the message' },
    { name: 'unfurl_links', label: 'Unfurl Links', type: 'boolean', default: false, description: 'Whether previews of mainly text-based links are shown' },
    { name: 'unfurl_media', label: 'Unfurl Media', type: 'boolean', default: true, description: 'Whether previews of media links are shown' },
    {
      name: 'ephemeral',
      label: 'Send as Ephemeral Message',
      type: 'fixedCollection',
      default: {},
      placeholder: 'Send as Ephemeral Message',
      addLabel: 'Send as Ephemeral Message',
      description: 'Whether the message is temporary and only visible to one user',
      show: { '/select': ['channel'] },
      groups: [
        {
          name: 'ephemeralValues',
          label: 'Send as Ephemeral Message',
          children: [
            { name: 'user', label: 'User to Send', type: 'resourceLocator', default: { mode: 'list', value: '' }, placeholder: 'Select a user...', modes: userModes(false) },
            { name: 'ephemeral', label: 'Send as Ephemeral Message', type: 'boolean', default: true, description: 'Whether the message is temporary and only visible to one user' },
          ],
        },
      ],
    },
    { name: 'ephemeral', label: 'Send as Ephemeral Message', type: 'boolean', default: true, description: 'Whether the message is temporary and only visible to the user', show: { '/select': ['user'] } },
    {
      name: 'sendAsUser',
      label: 'Send as User',
      type: 'string',
      default: '',
      description: 'Username the message appears to come from; needs the chat:write.customize scope',
      show: { '/authentication': ['accessToken'] },
    },
  ],
};

const messageParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'post',
    show: { resource: ['message'] },
    options: [
      { value: 'delete', label: 'Delete', description: 'Delete a message' },
      { value: 'getPermalink', label: 'Get Permalink', description: 'Get the permanent link of a message' },
      { value: 'search', label: 'Search', description: 'Search for messages' },
      { value: 'post', label: 'Send', description: 'Send a message' },
      { value: 'sendAndWait', label: 'Send and Wait for Response', description: 'Send a message and pause until the reply arrives' },
      { value: 'update', label: 'Update', description: 'Update a message' },
    ],
  },
  channelLocator(on('message', 'getPermalink'), 'The channel of the message', { required: false }),
  timestampParam('timestamp', on('message', 'getPermalink'), 'Timestamp of the message'),
  // post
  sendToSelector(on('message', 'post'), 'Send Message To', ''),
  channelLocator({ ...on('message', 'post'), select: ['channel'] }, 'The channel to send to', { withName: true }),
  userLocator({ ...on('message', 'post'), select: ['user'] }, undefined, true),
  messageTypeParam('post'),
  {
    name: 'text',
    label: 'Message Text',
    type: 'string',
    default: '',
    required: true,
    description: 'Text of the message; Slack Markdown unless switched off in the options',
    show: { ...on('message', 'post'), messageType: ['text'] },
  },
  blocksParam('post'),
  notificationTextParam('post'),
  { name: 'noticeAttachments', label: 'This is a legacy Slack feature. Slack advises to instead use Blocks.', type: 'notice', default: '', show: { ...on('message', 'post'), messageType: ['attachment'] } },
  {
    name: 'attachments',
    label: 'Attachments',
    type: 'json',
    default: [],
    description: `List of attachment objects (JSON), each with the fields ${attachmentChildren.map((c) => c.name).join(', ')}; "fields" as { "item": [{ "title", "value", "short" }] } or as a list`,
    show: { ...on('message', 'post'), messageType: ['attachment'] },
  },
  postOptions,
  // update
  channelLocator(on('message', 'update'), 'The channel of the message to update'),
  timestampParam('ts', on('message', 'update'), 'Timestamp of the message to update'),
  messageTypeParam('update'),
  blocksParam('update'),
  notificationTextParam('update'),
  {
    name: 'text',
    label: 'Message Text',
    type: 'string',
    default: '',
    description: 'New text of the message; Slack Markdown unless switched off in the options',
    show: { ...on('message', 'update'), messageType: ['text'] },
  },
  {
    name: 'updateFields',
    label: 'Update Fields',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    addLabel: 'Add option',
    show: on('message', 'update'),
    children: [
      { name: 'link_names', label: 'Link User and Channel Names', type: 'boolean', default: false, description: 'Whether channel names and usernames become links' },
      { name: 'parse', label: 'Parse', type: 'options', default: 'client', description: 'How Slack treats the message text', options: opts(['client', 'Client'], ['full', 'Full'], ['none', 'None']) },
    ],
  },
  { name: 'otherOptions', label: 'Options', type: 'collection', default: {}, placeholder: 'Add option', addLabel: 'Add option', description: 'Further options of the message', show: on('message', 'update'), children: [includeLinkParam] },
  // delete
  sendToSelector(on('message', 'delete'), 'Delete Message From', ''),
  channelLocator({ ...on('message', 'delete'), select: ['channel'] }, 'The channel of the message to delete'),
  userLocator({ ...on('message', 'delete'), select: ['user'] }, undefined, false),
  timestampParam('timestamp', on('message', 'delete'), 'Timestamp of the message to delete'),
  // search
  { name: 'query', label: 'Search Query', type: 'string', default: '', required: true, description: 'Text to search for in messages', show: on('message', 'search') },
  {
    name: 'sort',
    label: 'Sort By',
    type: 'options',
    default: 'desc',
    description: 'Order of the results',
    options: opts(['desc', 'Newest'], ['asc', 'Oldest'], ['relevance', 'Relevance Score']),
    show: on('message', 'search'),
  },
  returnAllParam(on('message', 'search')),
  limitParam(on('message', 'search'), 25, 50),
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    addLabel: 'Add option',
    show: on('message', 'search'),
    children: [{ name: 'searchChannel', label: 'Search in Channel', type: 'multiOptions', loadOptions: { method: 'getChannelsName' }, default: [], description: 'Channels to search in; pick them or give names with an expression' }],
  },
  // send and wait: channel or user (default user), no subject
  ...sendAndWaitProperties(
    [
      sendToSelector(undefined, 'Send Message To', 'user'),
      channelLocator({ select: ['channel'] }, 'The channel to send to', { withName: true }),
      userLocator({ select: ['user'] }, undefined, true),
    ],
    { subject: false },
  ),
];

// -------------------------------------------------------------------------------------------------------------------
// Star (StarDescription.js)
// -------------------------------------------------------------------------------------------------------------------

const starParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'add',
    show: { resource: ['star'] },
    options: [
      { value: 'add', label: 'Add', description: 'Add a star to an item' },
      { value: 'delete', label: 'Delete', description: 'Remove a star from an item' },
      { value: 'getAll', label: 'Get Many', description: 'Get many stars of the authenticated user' },
    ],
  },
  {
    name: 'target',
    label: 'Item to Add Star',
    type: 'options',
    required: true,
    default: '',
    placeholder: 'Select...',
    description: 'Whether a message or a file gets the star',
    options: opts(['message', 'Message'], ['file', 'File']),
    show: on('star', 'add'),
  },
  channelLocator({ ...on('star', 'add'), target: ['message', 'file'] }, 'The channel of the item', { required: false }),
  { name: 'fileId', label: 'File ID', type: 'string', default: '', description: 'File that gets the star', show: { ...on('star', 'add'), target: ['file'] } },
  timestampParam('timestamp', { ...on('star', 'add'), target: ['message'] }, 'Timestamp of the message that gets the star', false),
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    addLabel: 'Add option',
    show: on('star', 'add'),
    children: [{ name: 'fileComment', label: 'File Comment', type: 'string', default: '', description: 'File comment that gets the star' }],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    addLabel: 'Add option',
    show: on('star', 'delete'),
    children: [
      { name: 'channelId', label: 'Channel Name or ID', type: 'options', loadOptions: getChannels, default: '', description: 'Channel with the star, or channel of the message (with the timestamp)' },
      { name: 'fileId', label: 'File ID', type: 'string', default: '', description: 'File with the star' },
      { name: 'fileComment', label: 'File Comment', type: 'string', default: '', description: 'File comment with the star' },
      { name: 'timestamp', label: 'Message Timestamp', type: 'number', default: 0, placeholder: '1663233118.856619', description: 'Timestamp of the message with the star' },
    ],
  },
  returnAllParam(on('star', 'getAll')),
  limitParam(on('star', 'getAll'), 50, 100),
];

// -------------------------------------------------------------------------------------------------------------------
// File (FileDescription.js)
// -------------------------------------------------------------------------------------------------------------------

const fileParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'upload',
    show: { resource: ['file'] },
    options: [
      { value: 'get', label: 'Get', description: 'Get a file' },
      { value: 'getAll', label: 'Get Many', description: 'Get and filter the files of the workspace' },
      { value: 'upload', label: 'Upload', description: 'Upload a file' },
    ],
  },
  { name: 'binaryData', label: 'Binary File', type: 'boolean', default: false, description: 'Whether the file comes from a binary field of the input', show: { ...on('file', 'upload'), '@version': [2, 2.1] } },
  { name: 'fileContent', label: 'File Content', type: 'string', default: '', show: { ...on('file', 'upload'), binaryData: [false], '@version': [2, 2.1] } },
  {
    name: 'binaryPropertyName',
    label: 'File Property',
    type: 'string',
    default: 'data',
    required: true,
    description: 'Binary field of the input item with the file to upload',
    show: { ...on('file', 'upload'), binaryData: [true], '@version': [2, 2.1] },
  },
  {
    name: 'binaryPropertyName',
    label: 'File Property',
    type: 'string',
    default: 'data',
    required: true,
    description: 'Binary field of the input item with the file to upload',
    show: { ...on('file', 'upload'), '@version': [{ _cnd: { gte: 2.2 } }] },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    addLabel: 'Add option',
    description: 'Further options of the upload',
    show: on('file', 'upload'),
    children: [
      { name: 'channelIds', label: 'Channel Names or IDs', type: 'multiOptions', loadOptions: getChannels, default: [], description: 'Channels to share the file in', show: { '@version': [2, 2.1] } },
      { name: 'channelId', label: 'Channel Name or ID', type: 'options', loadOptions: getChannels, default: [], description: 'Channel to share the file in', show: { '@version': [{ _cnd: { gte: 2.2 } }] } },
      { name: 'fileName', label: 'File Name', type: 'string', default: '' },
      { name: 'initialComment', label: 'Initial Comment', type: 'string', default: '', description: 'Message that introduces the file in the channels' },
      { name: 'threadTs', label: 'Thread Timestamp', type: 'string', default: '', description: 'Timestamp of a message to upload the file as a reply; always the parent message, never a reply' },
      { name: 'title', label: 'Title', type: 'string', default: '' },
    ],
  },
  returnAllParam(on('file', 'getAll')),
  limitParam(on('file', 'getAll'), 50, 100),
  {
    name: 'filters',
    label: 'Filters',
    type: 'collection',
    default: {},
    placeholder: 'Add Field',
    addLabel: 'Add Field',
    show: on('file', 'getAll'),
    children: [
      { name: 'channelId', label: 'Channel Name or ID', type: 'options', loadOptions: getChannels, default: '', description: 'Only files of this channel' },
      { name: 'showFilesHidden', label: 'Show Files Hidden By Limit', type: 'boolean', default: false, description: 'Whether files hidden because of the file limit of the workspace are listed (truncated)' },
      { name: 'tsFrom', label: 'Message Timestamp From', type: 'string', default: '', description: 'Only files created at or after this timestamp' },
      { name: 'tsTo', label: 'Message Timestamp To', type: 'string', default: '', description: 'Only files created at or before this timestamp' },
      {
        name: 'types',
        label: 'Types',
        type: 'multiOptions',
        default: ['all'],
        description: 'Only files of these types',
        options: opts(['all', 'All'], ['gdocs', 'Google Docs'], ['images', 'Images'], ['pdfs', 'PDFs'], ['snippets', 'Snippets'], ['spaces', 'Spaces'], ['zips', 'zips']),
      },
      { name: 'userId', label: 'User Name or ID', type: 'options', loadOptions: getUsers, default: '', description: 'Only files created by this user' },
    ],
  },
  { name: 'fileId', label: 'File ID', type: 'string', default: '', show: on('file', 'get') },
];

// -------------------------------------------------------------------------------------------------------------------
// Reaction (ReactionDescription.js)
// -------------------------------------------------------------------------------------------------------------------

const reactionParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'add',
    show: { resource: ['reaction'] },
    options: [
      { value: 'add', label: 'Add', description: 'Add a reaction to a message' },
      { value: 'get', label: 'Get', description: 'Get the reactions of a message' },
      { value: 'remove', label: 'Remove', description: 'Remove a reaction from a message' },
    ],
  },
  channelLocator(on('reaction', 'add', 'get', 'remove'), 'The channel of the message'),
  timestampParam('timestamp', on('reaction', 'add', 'get', 'remove'), 'Timestamp of the message'),
  { name: 'name', label: 'Emoji Code', type: 'string', default: '', required: true, placeholder: '+1', description: `Emoji of the reaction. ${emojiDescription}.`, show: on('reaction', 'add', 'remove') },
];

// -------------------------------------------------------------------------------------------------------------------
// User (UserDescription.js)
// -------------------------------------------------------------------------------------------------------------------

const userParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'info',
    show: { resource: ['user'] },
    options: [
      { value: 'info', label: 'Get', description: 'Get information about a user' },
      { value: 'getAll', label: 'Get Many', description: 'Get a list of many users' },
      { value: 'getProfile', label: "Get User's Profile", description: 'Get the profile of a user' },
      { value: 'getPresence', label: "Get User's Status", description: 'Get the online status of a user' },
      { value: 'updateProfile', label: "Update User's Profile", description: 'Update the profile of a user' },
    ],
  },
  userLocator(on('user', 'info', 'getProfile'), 'The user to get information about', false),
  returnAllParam(on('user', 'getAll')),
  limitParam(on('user', 'getAll'), 50, 100),
  userLocator(on('user', 'getPresence'), 'The user to get the online status of', false),
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add Field',
    addLabel: 'Add Field',
    show: on('user', 'updateProfile'),
    children: [
      {
        name: 'customFieldUi',
        label: 'Custom Fields',
        type: 'fixedCollection',
        multiple: true,
        default: {},
        placeholder: 'Add Custom Fields',
        addLabel: 'Add Custom Fields',
        groups: [
          {
            name: 'customFieldValues',
            label: 'Custom Field',
            children: [
              { name: 'id', label: 'Field Name or ID', type: 'options', loadOptions: { method: 'getTeamFields' }, default: '', description: 'Profile field to set' },
              { name: 'value', label: 'Field Value', type: 'string', default: '', description: 'Value of the field' },
              { name: 'alt', label: 'Alt', type: 'string', default: '' },
            ],
          },
        ],
      },
      { name: 'email', label: 'Email', type: 'string', default: '', placeholder: 'name@email.com', description: 'Only admins of paid workspaces can change this field' },
      { name: 'first_name', label: 'First Name', type: 'string', default: '' },
      { name: 'last_name', label: 'Last Name', type: 'string', default: '' },
      {
        name: 'status',
        label: 'Set Status',
        type: 'fixedCollection',
        multiple: true,
        default: {},
        placeholder: 'Set Status',
        addLabel: 'Set Status',
        groups: [
          {
            name: 'set_status',
            label: 'Set Status',
            children: [
              { name: 'status_emoji', label: 'Status Emoji', type: 'string', default: '', description: 'Emoji of the workspace, such as :mountain_railway:' },
              { name: 'status_expiration', label: 'Status Expiration', type: 'dateTime', default: '', description: 'When the status is cleared (optional)' },
              { name: 'status_text', label: 'Status Text', type: 'string', default: '', description: 'Up to 100 characters; short is better' },
            ],
          },
        ],
      },
      { name: 'user', label: 'User ID', type: 'string', default: '', description: 'User to change; only for admins of paid workspaces' },
    ],
  },
];

// -------------------------------------------------------------------------------------------------------------------
// User group (UserGroupDescription.js)
// -------------------------------------------------------------------------------------------------------------------

const handleParam: ParamSchema = { name: 'handle', label: 'Handle', type: 'string', default: '', description: 'Mention handle, unique among channels, users and user groups' };
const groupDescriptionParam: ParamSchema = { name: 'description', label: 'Description', type: 'string', default: '', description: 'Short description of the user group' };
const userGroupIdParam = (operation: string): ParamSchema => ({ name: 'userGroupId', label: 'User Group ID', type: 'string', default: '', required: true, description: 'ID of the user group', show: on('userGroup', operation) });

const userGroupParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'create',
    show: { resource: ['userGroup'] },
    options: [
      { value: 'create', label: 'Create', description: 'Create a user group' },
      { value: 'disable', label: 'Disable', description: 'Disable a user group' },
      { value: 'enable', label: 'Enable', description: 'Enable a user group' },
      { value: 'getAll', label: 'Get Many', description: 'Get many user groups' },
      { value: 'update', label: 'Update', description: 'Update a user group' },
    ],
  },
  { name: 'name', label: 'Name', type: 'string', default: '', required: true, description: 'Name of the user group, unique among user groups', show: on('userGroup', 'create') },
  {
    name: 'Options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add Field',
    addLabel: 'Add Field',
    show: on('userGroup', 'create'),
    children: [
      { name: 'channelIds', label: 'Channel Names or IDs', type: 'multiOptions', loadOptions: getChannels, default: [], description: 'Default channels of the user group' },
      groupDescriptionParam,
      handleParam,
      includeCount,
    ],
  },
  userGroupIdParam('disable'),
  { name: 'options', label: 'Options', type: 'collection', default: {}, placeholder: 'Add Field', addLabel: 'Add Field', show: on('userGroup', 'disable'), children: [includeCount] },
  userGroupIdParam('enable'),
  { name: 'option', label: 'Options', type: 'collection', default: {}, placeholder: 'Add Field', addLabel: 'Add Field', show: on('userGroup', 'enable'), children: [includeCount] },
  returnAllParam(on('userGroup', 'getAll')),
  limitParam(on('userGroup', 'getAll'), 100, 500),
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add Field',
    addLabel: 'Add Field',
    show: on('userGroup', 'getAll'),
    children: [
      includeCount,
      { name: 'include_disabled', label: 'Include Disabled', type: 'boolean', default: true, description: 'Whether disabled user groups are included' },
      { name: 'include_users', label: 'Include Users', type: 'boolean', default: true, description: 'Whether the users of each user group are included' },
    ],
  },
  userGroupIdParam('update'),
  {
    name: 'updateFields',
    label: 'Update Fields',
    type: 'collection',
    default: {},
    placeholder: 'Add Field',
    addLabel: 'Add Field',
    show: on('userGroup', 'update'),
    children: [
      { name: 'channels', label: 'Channel Names or IDs', type: 'multiOptions', loadOptions: getChannels, default: [], description: 'Default channels of the user group' },
      groupDescriptionParam,
      handleParam,
      includeCount,
      { name: 'name', label: 'Name', type: 'string', default: '', description: 'Name of the user group, unique among user groups' },
    ],
  },
];

// -------------------------------------------------------------------------------------------------------------------
// Slack node
// -------------------------------------------------------------------------------------------------------------------

export const slackParameters: ParamSchema[] = [
  { name: 'authentication', label: 'Authentication', type: 'options', default: 'accessToken', options: opts(['accessToken', 'Access Token'], ['oAuth2', 'OAuth2']) },
  {
    name: 'resource',
    label: 'Resource',
    type: 'options',
    noExpression: true,
    default: 'message',
    options: opts(['channel', 'Channel'], ['file', 'File'], ['message', 'Message'], ['reaction', 'Reaction'], ['star', 'Star'], ['user', 'User'], ['userGroup', 'User Group']),
  },
  ...channelParameters,
  ...messageParameters,
  ...starParameters,
  ...fileParameters,
  ...reactionParameters,
  ...userParameters,
  ...userGroupParameters,
];

// -------------------------------------------------------------------------------------------------------------------
// Slack Trigger (M49)
// Reference: n8n-nodes-base 1.121.0, nodes/Slack/SlackTrigger.node.js (description.properties, version 1). Names,
// defaults, options and visibility rules as in the reference; the notices are filuflow's own texts without links to the
// reference documentation, the descriptions likewise.
// -------------------------------------------------------------------------------------------------------------------

/** Events whose channel can be watched (reference: show rule of watchWorkspace and its notice) */
const CHANNEL_EVENTS = ['any_event', 'message', 'reaction_added', 'file_share', 'app_mention'];

export const slackTriggerParameters: ParamSchema[] = [
  { name: 'authentication', label: 'Authentication', type: 'hidden', default: 'accessToken' },
  {
    name: 'notice',
    label:
      'Set up a webhook in your Slack app to enable this node: enter the production URL as the Request URL under "Event Subscriptions" and subscribe to the bot events you need. We also recommend setting a signing secret ("Signature Secret" in the credential) to ensure the authenticity of requests.',
    type: 'notice',
    default: '',
  },
  {
    name: 'trigger',
    label: 'Trigger On',
    type: 'multiOptions',
    default: [],
    options: [
      { value: 'any_event', label: 'Any Event', description: 'Triggers on any event' },
      { value: 'app_mention', label: 'Bot / App Mention', description: 'When your bot or app is mentioned in a channel the app is added to' },
      { value: 'file_public', label: 'File Made Public', description: 'When a file is made public' },
      { value: 'file_share', label: 'File Shared', description: 'When a file is shared in a channel the app is added to' },
      { value: 'message', label: 'New Message Posted to Channel', description: 'When a message is posted to a channel the app is added to' },
      { value: 'channel_created', label: 'New Public Channel Created', description: 'When a new public channel is created' },
      { value: 'team_join', label: 'New User', description: 'When a new user is added to Slack' },
      { value: 'reaction_added', label: 'Reaction Added', description: 'When a reaction is added to a message the app is added to' },
    ],
  },
  {
    name: 'watchWorkspace',
    label: 'Watch Whole Workspace',
    type: 'boolean',
    default: false,
    description: 'Whether to watch for the event in the whole workspace, rather than a specific channel',
    show: { trigger: CHANNEL_EVENTS },
  },
  {
    name: 'notice',
    label: 'This will use one execution for every event in any channel your bot is in, use with caution',
    type: 'notice',
    default: '',
    show: { trigger: CHANNEL_EVENTS, watchWorkspace: [true] },
  },
  {
    name: 'channelId',
    label: 'Channel to Watch',
    type: 'resourceLocator',
    required: true,
    default: { mode: 'list', value: '' },
    placeholder: 'Select a channel...',
    description: 'The Slack channel to listen to events from. Applies to events: Bot/App mention, File Shared, New Message Posted on Channel, Reaction Added.',
    show: { watchWorkspace: [false] },
    modes: channelModes(false),
  },
  {
    name: 'downloadFiles',
    label: 'Download Files',
    type: 'boolean',
    default: false,
    description: 'Whether to download the files and add it to the output',
    show: { trigger: ['any_event', 'file_share'] },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add Field',
    addLabel: 'Add Field',
    children: [
      { name: 'resolveIds', label: 'Resolve IDs', type: 'boolean', default: false, description: 'Whether to resolve the IDs to their respective names and return them' },
      {
        name: 'userIds',
        label: 'Usernames or IDs to Ignore',
        type: 'multiOptions',
        loadOptions: getUsers,
        default: [],
        description: 'Users whose events do not start the workflow; pick them from the list or give user IDs with an expression',
      },
    ],
  },
];
