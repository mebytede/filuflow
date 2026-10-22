// OAuth2 credential types with fixed service data (M28). Each type extends oAuth2Api (n8n ICredentialType.extends)
// and sets grant type, URLs, scopes, query parameters and the kind of client authentication as hidden fields.
// Names, values and visible extra fields as in n8n 1.123.0 (n8n-nodes-base 1.121.0),
// packages/nodes-base/credentials/<Type>.credentials.ts, e.g. GoogleOAuth2Api.credentials.ts, GmailOAuth2Api.credentials.ts,
// MicrosoftOAuth2Api.credentials.ts, GithubOAuth2Api.credentials.ts. Values starting with "=" are expressions over $self (the other
// values of the credential), as n8n evaluates them on load (credentials-helper.ts applyDefaultsAndOverwrites).
import type { CredentialField, CredentialTypeSchema } from './types.js';

const hidden = (name: string, value: string): CredentialField => ({ name, label: name, kind: 'hidden', default: value });

interface ServiceOAuth2 {
  grantType?: 'authorizationCode' | 'pkce';
  authUrl: string;
  accessTokenUrl: string;
  scope?: string;
  authQueryParameters?: string;
  authentication: 'header' | 'body';
}

/** Type with all service data as hidden fields (order as in n8n) */
function service(name: string, label: string, description: string, s: ServiceOAuth2, extra: CredentialField[] = []): CredentialTypeSchema {
  return {
    name,
    label,
    description,
    extends: ['oAuth2Api'],
    fields: [
      hidden('grantType', s.grantType ?? 'authorizationCode'),
      hidden('authUrl', s.authUrl),
      hidden('accessTokenUrl', s.accessTokenUrl),
      ...(s.scope !== undefined ? [hidden('scope', s.scope)] : []),
      hidden('authQueryParameters', s.authQueryParameters ?? ''),
      hidden('authentication', s.authentication),
      ...extra,
    ],
  };
}

/** Type that only sets the scope of a service type (Google, Microsoft) */
const scoped = (name: string, parent: string, label: string, scope: string, extra: CredentialField[] = []): CredentialTypeSchema => ({
  name,
  label,
  description: `${label} with fixed permissions (scopes).`,
  extends: [parent],
  fields: [hidden('scope', scope), ...extra],
});

const G = 'https://www.googleapis.com/auth/';
const gScopes = (...s: string[]) => s.map((x) => (x.startsWith('https://') ? x : G + x)).join(' ');

/** Base URL of a GitHub server (api.github.com -> github.com, otherwise protocol and host) */
const githubHost = '{{$self["server"] === "https://api.github.com" ? "https://github.com" : $self["server"].split("://")[0] + "://" + $self["server"].split("://")[1].split("/")[0]}}';

export const OAUTH2_SERVICE_TYPES: CredentialTypeSchema[] = [
  {
    name: 'googleOAuth2Api',
    label: 'Google OAuth2 API',
    description: 'OAuth2 for Google services with a custom scope.',
    extends: ['oAuth2Api'],
    fields: [
      hidden('grantType', 'authorizationCode'),
      hidden('authUrl', 'https://accounts.google.com/o/oauth2/v2/auth'),
      hidden('accessTokenUrl', 'https://oauth2.googleapis.com/token'),
      hidden('authQueryParameters', 'access_type=offline&prompt=consent'),
      hidden('authentication', 'body'),
    ],
  },
  scoped('gmailOAuth2', 'googleOAuth2Api', 'Gmail OAuth2 API', gScopes('gmail.labels', 'gmail.addons.current.action.compose', 'gmail.addons.current.message.action', 'https://mail.google.com/', 'gmail.modify', 'gmail.compose')),
  scoped('googleSheetsOAuth2Api', 'googleOAuth2Api', 'Google Sheets OAuth2 API', gScopes('drive.file', 'spreadsheets', 'drive.metadata')),
  scoped('googleDriveOAuth2Api', 'googleOAuth2Api', 'Google Drive OAuth2 API', gScopes('drive', 'drive.appdata', 'drive.photos.readonly')),
  scoped('googleCalendarOAuth2Api', 'googleOAuth2Api', 'Google Calendar OAuth2 API', gScopes('calendar', 'calendar.events')),
  scoped('googleDocsOAuth2Api', 'googleOAuth2Api', 'Google Docs OAuth2 API', gScopes('documents', 'drive', 'drive.file')),
  scoped('googleSlidesOAuth2Api', 'googleOAuth2Api', 'Google Slides OAuth2 API', gScopes('drive.file', 'presentations')),
  scoped('googleContactsOAuth2Api', 'googleOAuth2Api', 'Google Contacts OAuth2 API', gScopes('contacts')),
  scoped('googleTasksOAuth2Api', 'googleOAuth2Api', 'Google Tasks OAuth2 API', gScopes('tasks')),
  scoped('googleBigQueryOAuth2Api', 'googleOAuth2Api', 'Google BigQuery OAuth2 API', gScopes('bigquery', 'cloud-platform', 'drive')),
  scoped('googleChatOAuth2Api', 'googleOAuth2Api', 'Google Chat OAuth2 API', gScopes('chat.spaces', 'chat.messages', 'chat.memberships')),
  scoped('googleTranslateOAuth2Api', 'googleOAuth2Api', 'Google Translate OAuth2 API', gScopes('cloud-translation')),
  scoped('googleAnalyticsOAuth2', 'googleOAuth2Api', 'Google Analytics OAuth2 API', gScopes('analytics', 'analytics.readonly')),
  scoped(
    'googleCloudStorageOAuth2Api',
    'googleOAuth2Api',
    'Google Cloud Storage OAuth2 API',
    gScopes('cloud-platform', 'cloud-platform.read-only', 'devstorage.full_control', 'devstorage.read_only', 'devstorage.read_write'),
  ),
  scoped('youTubeOAuth2Api', 'googleOAuth2Api', 'YouTube OAuth2 API', gScopes('youtube', 'youtubepartner', 'youtube.force-ssl', 'youtube.upload', 'youtubepartner-channel-audit')),
  {
    name: 'microsoftOAuth2Api',
    label: 'Microsoft OAuth2 API',
    description: 'OAuth2 for Microsoft Entra ID (Microsoft 365, Graph) with a custom scope.',
    extends: ['oAuth2Api'],
    fields: [
      hidden('grantType', 'authorizationCode'),
      { name: 'authUrl', label: 'Authorization URL', kind: 'string', default: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' },
      { name: 'accessTokenUrl', label: 'Access Token URL', kind: 'string', default: 'https://login.microsoftonline.com/common/oauth2/v2.0/token' },
      hidden('authQueryParameters', 'response_mode=query'),
      hidden('authentication', 'body'),
    ],
  },
  scoped(
    'microsoftOutlookOAuth2Api',
    'microsoftOAuth2Api',
    'Microsoft Outlook OAuth2 API',
    'openid offline_access Contacts.Read Contacts.ReadWrite Calendars.Read Calendars.Read.Shared Calendars.ReadWrite Mail.ReadWrite Mail.ReadWrite.Shared Mail.Send Mail.Send.Shared MailboxSettings.Read',
    [
      { name: 'useShared', label: 'Use Shared Mailbox', kind: 'boolean', default: false },
      { name: 'userPrincipalName', label: 'User Principal Name', kind: 'string', default: '', hint: 'UPN or ID of the target mailbox', show: { useShared: [true] } },
    ],
  ),
  scoped('microsoftTeamsOAuth2Api', 'microsoftOAuth2Api', 'Microsoft Teams OAuth2 API', 'openid offline_access User.ReadWrite.All Group.ReadWrite.All Chat.ReadWrite ChannelMessage.Read.All'),
  scoped('microsoftOneDriveOAuth2Api', 'microsoftOAuth2Api', 'Microsoft OneDrive OAuth2 API', 'openid offline_access Files.ReadWrite.All'),
  scoped('microsoftExcelOAuth2Api', 'microsoftOAuth2Api', 'Microsoft Excel OAuth2 API', 'openid offline_access Files.ReadWrite'),
  scoped('microsoftSharePointOAuth2Api', 'microsoftOAuth2Api', 'Microsoft SharePoint OAuth2 API', '=openid offline_access https://{{$self.subdomain}}.sharepoint.com/.default', [
    { name: 'subdomain', label: 'Subdomain', kind: 'string', default: '', placeholder: 'company', hint: 'The part before .sharepoint.com' },
  ]),
  scoped('microsoftToDoOAuth2Api', 'microsoftOAuth2Api', 'Microsoft To Do OAuth2 API', 'openid offline_access Tasks.ReadWrite'),
  service('slackOAuth2Api', 'Slack OAuth2 API', 'OAuth2 for Slack (bot token with chat:write, user scopes for the other functions).', {
    authUrl: 'https://slack.com/oauth/v2/authorize',
    accessTokenUrl: 'https://slack.com/api/oauth.v2.access',
    scope: 'chat:write',
    authQueryParameters:
      'user_scope=channels:read channels:write channels:history chat:write files:read files:write groups:read groups:history im:read im:history mpim:read mpim:history reactions:read reactions:write stars:read stars:write usergroups:write usergroups:read users.profile:read users.profile:write users:read search:read',
    authentication: 'body',
  }),
  service(
    'githubOAuth2Api',
    'GitHub OAuth2 API',
    'OAuth2 for GitHub and GitHub Enterprise.',
    {
      authUrl: `=${githubHost}/login/oauth/authorize`,
      accessTokenUrl: `=${githubHost}/login/oauth/access_token`,
      scope: 'repo,admin:repo_hook,admin:org,admin:org_hook,gist,notifications,user,write:packages,read:packages,delete:packages,workflow',
      authentication: 'header',
    },
    [{ name: 'server', label: 'GitHub Server', kind: 'string', default: 'https://api.github.com', hint: 'Only change for GitHub Enterprise' }],
  ),
  service(
    'gitlabOAuth2Api',
    'GitLab OAuth2 API',
    'OAuth2 for GitLab (also self-hosted).',
    { authUrl: '={{$self["server"]}}/oauth/authorize', accessTokenUrl: '={{$self["server"]}}/oauth/token', scope: 'api', authentication: 'body' },
    [{ name: 'server', label: 'GitLab Server', kind: 'string', default: 'https://gitlab.com' }],
  ),
  service('notionOAuth2Api', 'Notion OAuth2 API', 'OAuth2 for Notion (public integration).', {
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    accessTokenUrl: 'https://api.notion.com/v1/oauth/token',
    scope: '',
    authentication: 'header',
  }),
  service('hubspotOAuth2Api', 'HubSpot OAuth2 API', 'OAuth2 for HubSpot.', {
    authUrl: 'https://app.hubspot.com/oauth/authorize',
    accessTokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    scope:
      'crm.lists.write crm.objects.contacts.read crm.objects.contacts.write crm.objects.companies.read crm.objects.companies.write crm.objects.deals.read crm.objects.deals.write crm.objects.owners.read crm.schemas.companies.read crm.schemas.contacts.read crm.schemas.deals.read forms tickets',
    authQueryParameters: 'grant_type=authorization_code',
    authentication: 'body',
  }),
  service('airtableOAuth2Api', 'Airtable OAuth2 API', 'OAuth2 with PKCE for Airtable.', {
    grantType: 'pkce',
    authUrl: 'https://airtable.com/oauth2/v1/authorize',
    accessTokenUrl: 'https://airtable.com/oauth2/v1/token',
    scope: 'schema.bases:read data.records:read data.records:write',
    authentication: 'header',
  }),
  {
    name: 'discordOAuth2Api',
    label: 'Discord OAuth2 API',
    description: 'OAuth2 for Discord, optionally with bot token and custom scopes.',
    extends: ['oAuth2Api'],
    fields: [
      { name: 'botToken', label: 'Bot Token', kind: 'password', default: '' },
      hidden('grantType', 'authorizationCode'),
      hidden('authUrl', 'https://discord.com/api/oauth2/authorize'),
      hidden('accessTokenUrl', 'https://discord.com/api/oauth2/token'),
      hidden('authQueryParameters', 'permissions=1642758929655'),
      { name: 'customScopes', label: 'Custom Scopes', kind: 'boolean', default: false },
      { name: 'enabledScopes', label: 'Scopes', kind: 'string', default: 'identify guilds guilds.join bot', show: { customScopes: [true] }, hint: 'Without the default scopes, nodes may not work' },
      hidden('scope', '={{$self["customScopes"] ? $self["enabledScopes"] : "identify guilds guilds.join bot"}}'),
    ],
  },
  service(
    'dropboxOAuth2Api',
    'Dropbox OAuth2 API',
    'OAuth2 for Dropbox.',
    {
      authUrl: 'https://www.dropbox.com/oauth2/authorize',
      accessTokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      scope: 'files.content.write files.content.read sharing.read account_info.read',
      authQueryParameters: 'token_access_type=offline&force_reapprove=true',
      authentication: 'header',
    },
    [
      {
        name: 'accessType',
        label: 'App Access Type',
        kind: 'options',
        default: 'full',
        options: [
          { value: 'folder', label: 'App Folder' },
          { value: 'full', label: 'Full Dropbox' },
        ],
      },
    ],
  ),
  {
    name: 'linearOAuth2Api',
    label: 'Linear OAuth2 API',
    description: 'OAuth2 for Linear.',
    extends: ['oAuth2Api'],
    fields: [
      hidden('grantType', 'authorizationCode'),
      hidden('authUrl', 'https://linear.app/oauth/authorize'),
      hidden('accessTokenUrl', 'https://api.linear.app/oauth/token'),
      {
        name: 'actor',
        label: 'Actor',
        kind: 'options',
        default: 'user',
        options: [
          { value: 'user', label: 'User (entries on behalf of the person)' },
          { value: 'application', label: 'Application' },
        ],
      },
      { name: 'includeAdminScope', label: 'Include Admin Scope', kind: 'boolean', default: false, hint: 'Needed to create webhooks' },
      hidden('scope', '={{$self["includeAdminScope"] ? "read write issues:create comments:create admin" : "read write issues:create comments:create"}}'),
      hidden('authQueryParameters', '={{"actor="+$self["actor"]}}'),
      hidden('authentication', 'body'),
    ],
  },
  service(
    'salesforceOAuth2Api',
    'Salesforce OAuth2 API',
    'OAuth2 with PKCE for Salesforce (production or sandbox).',
    {
      grantType: 'pkce',
      authUrl: '={{ $self["environment"] === "sandbox" ? "https://test.salesforce.com/services/oauth2/authorize?prompt=login" : "https://login.salesforce.com/services/oauth2/authorize?prompt=login" }}',
      accessTokenUrl: '={{ $self["environment"] === "sandbox" ? "https://test.salesforce.com/services/oauth2/token" : "https://login.salesforce.com/services/oauth2/token" }}',
      scope: 'full refresh_token',
      authentication: 'header',
    },
    [
      {
        name: 'environment',
        label: 'Environment Type',
        kind: 'options',
        default: 'production',
        options: [
          { value: 'production', label: 'Production' },
          { value: 'sandbox', label: 'Sandbox' },
        ],
      },
    ],
  ),
  service('zoomOAuth2Api', 'Zoom OAuth2 API', 'OAuth2 for Zoom.', { authUrl: 'https://zoom.us/oauth/authorize', accessTokenUrl: 'https://zoom.us/oauth/token', scope: '', authentication: 'header' }),
  service('asanaOAuth2Api', 'Asana OAuth2 API', 'OAuth2 for Asana.', {
    authUrl: 'https://app.asana.com/-/oauth_authorize',
    accessTokenUrl: 'https://app.asana.com/-/oauth_token',
    scope: '',
    authentication: 'body',
  }),
  service('clickUpOAuth2Api', 'ClickUp OAuth2 API', 'OAuth2 for ClickUp.', {
    authUrl: 'https://app.clickup.com/api',
    accessTokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
    scope: '',
    authentication: 'body',
  }),
  service('pipedriveOAuth2Api', 'Pipedrive OAuth2 API', 'OAuth2 for Pipedrive.', {
    authUrl: 'https://oauth.pipedrive.com/oauth/authorize',
    accessTokenUrl: 'https://oauth.pipedrive.com/oauth/token',
    scope: '',
    authentication: 'header',
  }),
  service('xeroOAuth2Api', 'Xero OAuth2 API', 'OAuth2 for Xero.', {
    authUrl: 'https://login.xero.com/identity/connect/authorize',
    accessTokenUrl: 'https://identity.xero.com/connect/token',
    scope: 'offline_access accounting.transactions accounting.settings accounting.contacts',
    authentication: 'header',
  }),
  service('twitterOAuth2Api', 'X OAuth2 API', 'OAuth2 with PKCE for X (Twitter).', {
    grantType: 'pkce',
    authUrl: 'https://twitter.com/i/oauth2/authorize',
    accessTokenUrl: 'https://api.twitter.com/2/oauth2/token',
    scope:
      'tweet.read users.read tweet.write tweet.moderate.write users.read follows.read follows.write offline.access like.read like.write dm.write dm.read list.read list.write',
    authentication: 'header',
  }),
  {
    name: 'linkedInOAuth2Api',
    label: 'LinkedIn OAuth2 API',
    description: 'OAuth2 for LinkedIn.',
    extends: ['oAuth2Api'],
    fields: [
      hidden('grantType', 'authorizationCode'),
      { name: 'organizationSupport', label: 'Organization Support', kind: 'boolean', default: true },
      hidden('authUrl', 'https://www.linkedin.com/oauth/v2/authorization'),
      hidden('accessTokenUrl', 'https://www.linkedin.com/oauth/v2/accessToken'),
      hidden('scope', '=w_member_social{{$self["organizationSupport"] === true ? ",w_organization_social": $self["legacy"] === true ? ",r_liteprofile,r_emailaddress" : ",profile,email,openid"}}'),
      hidden('authQueryParameters', ''),
      hidden('authentication', 'body'),
      { name: 'legacy', label: 'Legacy', kind: 'boolean', default: true },
    ],
  },
  service(
    'spotifyOAuth2Api',
    'Spotify OAuth2 API',
    'OAuth2 for Spotify.',
    {
      authUrl: 'https://accounts.spotify.com/authorize',
      accessTokenUrl: 'https://accounts.spotify.com/api/token',
      scope:
        'user-read-playback-state playlist-read-collaborative user-modify-playback-state playlist-modify-public user-read-currently-playing playlist-read-private user-read-recently-played playlist-modify-private user-library-read user-follow-read',
      authentication: 'header',
    },
    // in n8n for the Spotify node
    [hidden('server', 'https://api.spotify.com/')],
  ),
  service(
    'zendeskOAuth2Api',
    'Zendesk OAuth2 API',
    'OAuth2 for Zendesk.',
    {
      authUrl: '=https://{{$self["subdomain"]}}.zendesk.com/oauth/authorizations/new',
      accessTokenUrl: '=https://{{$self["subdomain"]}}.zendesk.com/oauth/tokens',
      scope: 'read write',
      authentication: 'body',
    },
    [{ name: 'subdomain', label: 'Subdomain', kind: 'string', default: '', required: true, placeholder: 'company', hint: 'The part before .zendesk.com' }],
  ),
  service('todoistOAuth2Api', 'Todoist OAuth2 API', 'OAuth2 for Todoist.', {
    authUrl: 'https://todoist.com/oauth/authorize',
    accessTokenUrl: 'https://todoist.com/oauth/access_token',
    scope: 'data:read_write,data:delete',
    authentication: 'body',
  }),
  service('mondayComOAuth2Api', 'Monday.com OAuth2 API', 'OAuth2 for monday.com.', {
    authUrl: 'https://auth.monday.com/oauth2/authorize',
    accessTokenUrl: 'https://auth.monday.com/oauth2/token',
    scope: 'boards:write boards:read',
    authentication: 'body',
  }),
  service('boxOAuth2Api', 'Box OAuth2 API', 'OAuth2 for Box.', {
    authUrl: 'https://account.box.com/api/oauth2/authorize',
    accessTokenUrl: 'https://api.box.com/oauth2/token',
    scope: '',
    authentication: 'body',
  }),
  service('typeformOAuth2Api', 'Typeform OAuth2 API', 'OAuth2 for Typeform.', {
    authUrl: 'https://api.typeform.com/oauth/authorize',
    accessTokenUrl: 'https://api.typeform.com/oauth/token',
    scope: 'webhooks:write webhooks:read forms:read',
    authentication: 'header',
  }),
  service('calendlyOAuth2Api', 'Calendly OAuth2 API', 'OAuth2 for Calendly.', {
    authUrl: 'https://auth.calendly.com/oauth/authorize',
    accessTokenUrl: 'https://auth.calendly.com/oauth/token',
    scope: '',
    authentication: 'header',
  }),
  service(
    'mailchimpOAuth2Api',
    'Mailchimp OAuth2 API',
    'OAuth2 for Mailchimp.',
    { authUrl: 'https://login.mailchimp.com/oauth2/authorize', accessTokenUrl: 'https://login.mailchimp.com/oauth2/token', scope: '', authentication: 'body' },
    // in n8n for the Mailchimp node (data center of the account)
    [hidden('metadataUrl', 'https://login.mailchimp.com/oauth2/metadata')],
  ),
];
