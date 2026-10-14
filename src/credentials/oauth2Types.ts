// OAuth2-Credential-Typen mit festen Dienst-Daten (M28). Jeder Typ erweitert oAuth2Api (n8n ICredentialType.extends)
// und legt Grant Type, URLs, Scopes, Query-Parameter und die Art der Client-Authentifizierung als versteckte Felder fest.
// Namen, Werte und sichtbare Zusatzfelder wie n8n 1.123.0 (n8n-nodes-base 1.121.0),
// packages/nodes-base/credentials/<Typ>.credentials.ts, z. B. GoogleOAuth2Api.credentials.ts, GmailOAuth2Api.credentials.ts,
// MicrosoftOAuth2Api.credentials.ts, GithubOAuth2Api.credentials.ts. Werte mit "=" sind Ausdrücke über $self (die übrigen
// Werte des Credentials), wie n8n sie beim Laden auswertet (credentials-helper.ts applyDefaultsAndOverwrites).
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

/** Typ mit allen Dienst-Daten als versteckte Felder (Reihenfolge wie in n8n) */
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

/** Typ, der nur den Scope eines Dienst-Typs festlegt (Google, Microsoft) */
const scoped = (name: string, parent: string, label: string, scope: string, extra: CredentialField[] = []): CredentialTypeSchema => ({
  name,
  label,
  description: `${label} mit festen Berechtigungen (Scopes).`,
  extends: [parent],
  fields: [hidden('scope', scope), ...extra],
});

const G = 'https://www.googleapis.com/auth/';
const gScopes = (...s: string[]) => s.map((x) => (x.startsWith('https://') ? x : G + x)).join(' ');

/** Basis-URL eines GitHub-Servers (api.github.com -> github.com, sonst Protokoll und Host) */
const githubHost = '{{$self["server"] === "https://api.github.com" ? "https://github.com" : $self["server"].split("://")[0] + "://" + $self["server"].split("://")[1].split("/")[0]}}';

export const OAUTH2_SERVICE_TYPES: CredentialTypeSchema[] = [
  {
    name: 'googleOAuth2Api',
    label: 'Google OAuth2 API',
    description: 'OAuth2 für Google-Dienste mit eigenem Scope.',
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
    description: 'OAuth2 für Microsoft Entra ID (Microsoft 365, Graph) mit eigenem Scope.',
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
      { name: 'useShared', label: 'Geteiltes Postfach nutzen', kind: 'boolean', default: false },
      { name: 'userPrincipalName', label: 'User Principal Name', kind: 'string', default: '', hint: 'UPN oder ID des Zielpostfachs', show: { useShared: [true] } },
    ],
  ),
  scoped('microsoftTeamsOAuth2Api', 'microsoftOAuth2Api', 'Microsoft Teams OAuth2 API', 'openid offline_access User.ReadWrite.All Group.ReadWrite.All Chat.ReadWrite ChannelMessage.Read.All'),
  scoped('microsoftOneDriveOAuth2Api', 'microsoftOAuth2Api', 'Microsoft OneDrive OAuth2 API', 'openid offline_access Files.ReadWrite.All'),
  scoped('microsoftExcelOAuth2Api', 'microsoftOAuth2Api', 'Microsoft Excel OAuth2 API', 'openid offline_access Files.ReadWrite'),
  scoped('microsoftSharePointOAuth2Api', 'microsoftOAuth2Api', 'Microsoft SharePoint OAuth2 API', '=openid offline_access https://{{$self.subdomain}}.sharepoint.com/.default', [
    { name: 'subdomain', label: 'Subdomain', kind: 'string', default: '', placeholder: 'firma', hint: 'Der Teil vor .sharepoint.com' },
  ]),
  scoped('microsoftToDoOAuth2Api', 'microsoftOAuth2Api', 'Microsoft To Do OAuth2 API', 'openid offline_access Tasks.ReadWrite'),
  service('slackOAuth2Api', 'Slack OAuth2 API', 'OAuth2 für Slack (Bot-Token mit chat:write, Benutzer-Scopes für die übrigen Funktionen).', {
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
    'OAuth2 für GitHub und GitHub Enterprise.',
    {
      authUrl: `=${githubHost}/login/oauth/authorize`,
      accessTokenUrl: `=${githubHost}/login/oauth/access_token`,
      scope: 'repo,admin:repo_hook,admin:org,admin:org_hook,gist,notifications,user,write:packages,read:packages,delete:packages,workflow',
      authentication: 'header',
    },
    [{ name: 'server', label: 'GitHub-Server', kind: 'string', default: 'https://api.github.com', hint: 'Nur für GitHub Enterprise ändern' }],
  ),
  service(
    'gitlabOAuth2Api',
    'GitLab OAuth2 API',
    'OAuth2 für GitLab (auch selbst betrieben).',
    { authUrl: '={{$self["server"]}}/oauth/authorize', accessTokenUrl: '={{$self["server"]}}/oauth/token', scope: 'api', authentication: 'body' },
    [{ name: 'server', label: 'GitLab-Server', kind: 'string', default: 'https://gitlab.com' }],
  ),
  service('notionOAuth2Api', 'Notion OAuth2 API', 'OAuth2 für Notion (öffentliche Integration).', {
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    accessTokenUrl: 'https://api.notion.com/v1/oauth/token',
    scope: '',
    authentication: 'header',
  }),
  service('hubspotOAuth2Api', 'HubSpot OAuth2 API', 'OAuth2 für HubSpot.', {
    authUrl: 'https://app.hubspot.com/oauth/authorize',
    accessTokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    scope:
      'crm.lists.write crm.objects.contacts.read crm.objects.contacts.write crm.objects.companies.read crm.objects.companies.write crm.objects.deals.read crm.objects.deals.write crm.objects.owners.read crm.schemas.companies.read crm.schemas.contacts.read crm.schemas.deals.read forms tickets',
    authQueryParameters: 'grant_type=authorization_code',
    authentication: 'body',
  }),
  service('airtableOAuth2Api', 'Airtable OAuth2 API', 'OAuth2 mit PKCE für Airtable.', {
    grantType: 'pkce',
    authUrl: 'https://airtable.com/oauth2/v1/authorize',
    accessTokenUrl: 'https://airtable.com/oauth2/v1/token',
    scope: 'schema.bases:read data.records:read data.records:write',
    authentication: 'header',
  }),
  {
    name: 'discordOAuth2Api',
    label: 'Discord OAuth2 API',
    description: 'OAuth2 für Discord, optional mit Bot-Token und eigenen Scopes.',
    extends: ['oAuth2Api'],
    fields: [
      { name: 'botToken', label: 'Bot-Token', kind: 'password', default: '' },
      hidden('grantType', 'authorizationCode'),
      hidden('authUrl', 'https://discord.com/api/oauth2/authorize'),
      hidden('accessTokenUrl', 'https://discord.com/api/oauth2/token'),
      hidden('authQueryParameters', 'permissions=1642758929655'),
      { name: 'customScopes', label: 'Eigene Scopes', kind: 'boolean', default: false },
      { name: 'enabledScopes', label: 'Scopes', kind: 'string', default: 'identify guilds guilds.join bot', show: { customScopes: [true] }, hint: 'Ohne die Standard-Scopes funktionieren Knoten unter Umständen nicht' },
      hidden('scope', '={{$self["customScopes"] ? $self["enabledScopes"] : "identify guilds guilds.join bot"}}'),
    ],
  },
  service(
    'dropboxOAuth2Api',
    'Dropbox OAuth2 API',
    'OAuth2 für Dropbox.',
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
        label: 'Zugriff der App',
        kind: 'options',
        default: 'full',
        options: [
          { value: 'folder', label: 'App-Ordner' },
          { value: 'full', label: 'Ganze Dropbox' },
        ],
      },
    ],
  ),
  {
    name: 'linearOAuth2Api',
    label: 'Linear OAuth2 API',
    description: 'OAuth2 für Linear.',
    extends: ['oAuth2Api'],
    fields: [
      hidden('grantType', 'authorizationCode'),
      hidden('authUrl', 'https://linear.app/oauth/authorize'),
      hidden('accessTokenUrl', 'https://api.linear.app/oauth/token'),
      {
        name: 'actor',
        label: 'Akteur',
        kind: 'options',
        default: 'user',
        options: [
          { value: 'user', label: 'Benutzer (Einträge im Namen der Person)' },
          { value: 'application', label: 'Anwendung' },
        ],
      },
      { name: 'includeAdminScope', label: 'Admin-Scope anfordern', kind: 'boolean', default: false, hint: 'Nötig zum Anlegen von Webhooks' },
      hidden('scope', '={{$self["includeAdminScope"] ? "read write issues:create comments:create admin" : "read write issues:create comments:create"}}'),
      hidden('authQueryParameters', '={{"actor="+$self["actor"]}}'),
      hidden('authentication', 'body'),
    ],
  },
  service(
    'salesforceOAuth2Api',
    'Salesforce OAuth2 API',
    'OAuth2 mit PKCE für Salesforce (Produktion oder Sandbox).',
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
        label: 'Umgebung',
        kind: 'options',
        default: 'production',
        options: [
          { value: 'production', label: 'Produktion' },
          { value: 'sandbox', label: 'Sandbox' },
        ],
      },
    ],
  ),
  service('zoomOAuth2Api', 'Zoom OAuth2 API', 'OAuth2 für Zoom.', { authUrl: 'https://zoom.us/oauth/authorize', accessTokenUrl: 'https://zoom.us/oauth/token', scope: '', authentication: 'header' }),
  service('asanaOAuth2Api', 'Asana OAuth2 API', 'OAuth2 für Asana.', {
    authUrl: 'https://app.asana.com/-/oauth_authorize',
    accessTokenUrl: 'https://app.asana.com/-/oauth_token',
    scope: '',
    authentication: 'body',
  }),
  service('clickUpOAuth2Api', 'ClickUp OAuth2 API', 'OAuth2 für ClickUp.', {
    authUrl: 'https://app.clickup.com/api',
    accessTokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
    scope: '',
    authentication: 'body',
  }),
  service('pipedriveOAuth2Api', 'Pipedrive OAuth2 API', 'OAuth2 für Pipedrive.', {
    authUrl: 'https://oauth.pipedrive.com/oauth/authorize',
    accessTokenUrl: 'https://oauth.pipedrive.com/oauth/token',
    scope: '',
    authentication: 'header',
  }),
  service('xeroOAuth2Api', 'Xero OAuth2 API', 'OAuth2 für Xero.', {
    authUrl: 'https://login.xero.com/identity/connect/authorize',
    accessTokenUrl: 'https://identity.xero.com/connect/token',
    scope: 'offline_access accounting.transactions accounting.settings accounting.contacts',
    authentication: 'header',
  }),
  service('twitterOAuth2Api', 'X OAuth2 API', 'OAuth2 mit PKCE für X (Twitter).', {
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
    description: 'OAuth2 für LinkedIn.',
    extends: ['oAuth2Api'],
    fields: [
      hidden('grantType', 'authorizationCode'),
      { name: 'organizationSupport', label: 'Als Organisation posten', kind: 'boolean', default: true },
      hidden('authUrl', 'https://www.linkedin.com/oauth/v2/authorization'),
      hidden('accessTokenUrl', 'https://www.linkedin.com/oauth/v2/accessToken'),
      hidden('scope', '=w_member_social{{$self["organizationSupport"] === true ? ",w_organization_social": $self["legacy"] === true ? ",r_liteprofile,r_emailaddress" : ",profile,email,openid"}}'),
      hidden('authQueryParameters', ''),
      hidden('authentication', 'body'),
      { name: 'legacy', label: 'Alte API nutzen', kind: 'boolean', default: true },
    ],
  },
  service(
    'spotifyOAuth2Api',
    'Spotify OAuth2 API',
    'OAuth2 für Spotify.',
    {
      authUrl: 'https://accounts.spotify.com/authorize',
      accessTokenUrl: 'https://accounts.spotify.com/api/token',
      scope:
        'user-read-playback-state playlist-read-collaborative user-modify-playback-state playlist-modify-public user-read-currently-playing playlist-read-private user-read-recently-played playlist-modify-private user-library-read user-follow-read',
      authentication: 'header',
    },
    // in n8n für den Spotify-Knoten
    [hidden('server', 'https://api.spotify.com/')],
  ),
  service(
    'zendeskOAuth2Api',
    'Zendesk OAuth2 API',
    'OAuth2 für Zendesk.',
    {
      authUrl: '=https://{{$self["subdomain"]}}.zendesk.com/oauth/authorizations/new',
      accessTokenUrl: '=https://{{$self["subdomain"]}}.zendesk.com/oauth/tokens',
      scope: 'read write',
      authentication: 'body',
    },
    [{ name: 'subdomain', label: 'Subdomain', kind: 'string', default: '', required: true, placeholder: 'firma', hint: 'Der Teil vor .zendesk.com' }],
  ),
  service('todoistOAuth2Api', 'Todoist OAuth2 API', 'OAuth2 für Todoist.', {
    authUrl: 'https://todoist.com/oauth/authorize',
    accessTokenUrl: 'https://todoist.com/oauth/access_token',
    scope: 'data:read_write,data:delete',
    authentication: 'body',
  }),
  service('mondayComOAuth2Api', 'Monday.com OAuth2 API', 'OAuth2 für monday.com.', {
    authUrl: 'https://auth.monday.com/oauth2/authorize',
    accessTokenUrl: 'https://auth.monday.com/oauth2/token',
    scope: 'boards:write boards:read',
    authentication: 'body',
  }),
  service('boxOAuth2Api', 'Box OAuth2 API', 'OAuth2 für Box.', {
    authUrl: 'https://account.box.com/api/oauth2/authorize',
    accessTokenUrl: 'https://api.box.com/oauth2/token',
    scope: '',
    authentication: 'body',
  }),
  service('typeformOAuth2Api', 'Typeform OAuth2 API', 'OAuth2 für Typeform.', {
    authUrl: 'https://api.typeform.com/oauth/authorize',
    accessTokenUrl: 'https://api.typeform.com/oauth/token',
    scope: 'webhooks:write webhooks:read forms:read',
    authentication: 'header',
  }),
  service('calendlyOAuth2Api', 'Calendly OAuth2 API', 'OAuth2 für Calendly.', {
    authUrl: 'https://auth.calendly.com/oauth/authorize',
    accessTokenUrl: 'https://auth.calendly.com/oauth/token',
    scope: '',
    authentication: 'header',
  }),
  service(
    'mailchimpOAuth2Api',
    'Mailchimp OAuth2 API',
    'OAuth2 für Mailchimp.',
    { authUrl: 'https://login.mailchimp.com/oauth2/authorize', accessTokenUrl: 'https://login.mailchimp.com/oauth2/token', scope: '', authentication: 'body' },
    // in n8n für den Mailchimp-Knoten (Rechenzentrum des Kontos)
    [hidden('metadataUrl', 'https://login.mailchimp.com/oauth2/metadata')],
  ),
];
