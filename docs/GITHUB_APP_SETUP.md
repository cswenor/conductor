# GitHub App Setup

This guide walks through registering and configuring a GitHub App for Conductor.

## Overview

Conductor uses a GitHub App for:
- Receiving webhooks (issues, PRs, comments)
- Reading repository contents
- Creating branches and PRs
- Posting comments
- Creating check runs

## Prerequisites

- A GitHub account with permission to create GitHub Apps
- Access to the organization where you want to install the app
- Conductor running locally or deployed

## Step 1: Register the GitHub App

### Option A: Manual Registration

1. Go to **GitHub Settings > Developer settings > GitHub Apps > New GitHub App**

2. Fill in the basic information:
   - **GitHub App name**: `Conductor` (or your preferred name)
   - **Homepage URL**: Your Conductor instance URL
   - **Webhook URL**: `https://your-conductor-host.com/api/webhooks/github`
   - **Webhook secret**: Generate a secure random string (save this!)

3. Set **Repository permissions**:
   | Permission | Access |
   |------------|--------|
   | Contents | Read & write |
   | Issues | Read & write |
   | Metadata | Read |
   | Pull requests | Read & write |
   | Checks | Read & write |

4. Set **Organization permissions** (optional):
   | Permission | Access |
   |------------|--------|
   | Projects | Read & write |

5. Subscribe to **events**:
   - [x] Check run
   - [x] Check suite
   - [x] Issue comment
   - [x] Issues
   - [x] Pull request
   - [x] Pull request review
   - [x] Push

6. Set **Where can this GitHub App be installed?**:
   - Select "Only on this account" for private use
   - Select "Any account" if you want others to install it

7. Click **Create GitHub App**

### Option B: Manifest-Based Registration

Use the manifest file at `github-app-manifest.json` for automated registration:

1. Navigate to: `https://github.com/settings/apps/new?manifest=true`

2. Submit the manifest JSON

3. Complete the registration flow

## Step 2: Generate Private Key

1. After creating the app, scroll to **Private keys**
2. Click **Generate a private key**
3. Download the `.pem` file
4. Store it securely (you'll need it for Conductor)

## Step 3: Note Your App Credentials

After registration, note these values:
- **App ID**: Shown on the app settings page
- **Client ID**: Shown on the app settings page
- **Client Secret**: Generate one if needed for OAuth flows
- **Private Key**: The `.pem` file you downloaded
- **Webhook Secret**: The secret you set during registration

## Step 4: Install the App

1. Go to your GitHub App's page
2. Click **Install App** in the sidebar
3. Select the organization or account
4. Choose which repositories to grant access to:
   - "All repositories" or
   - "Only select repositories"
5. Click **Install**

Note the **Installation ID** from the URL after installation:
`https://github.com/settings/installations/{INSTALLATION_ID}`

## Step 5: Configure Conductor

Set the following environment variables:

```bash
# Required
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=your-webhook-secret

# Optional (for OAuth flows)
GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=secret123
```

### Private Key Formats

The private key can be provided as:

1. **Inline** (with escaped newlines):
   ```bash
   GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"
   ```

2. **File path**:
   ```bash
   GITHUB_PRIVATE_KEY_PATH=/path/to/private-key.pem
   ```

3. **Base64 encoded**:
   ```bash
   GITHUB_PRIVATE_KEY_BASE64=LS0tLS1CRUdJTi...
   ```

## Step 6: Verify Setup

1. Start Conductor: `pnpm dev`

2. Check the health endpoint includes GitHub status:
   ```bash
   curl http://localhost:3000/api/health
   ```

3. Create a test issue in an installed repository

4. Verify the webhook was received in Conductor's logs

## Local Development

For local development without a public URL:

### Option 1: smee.io (Recommended)

1. Go to https://smee.io and click "Start a new channel"
2. Copy the webhook proxy URL
3. Install the smee client:
   ```bash
   npm install -g smee-client
   ```
4. Run the proxy:
   ```bash
   smee -u https://smee.io/YOUR_CHANNEL -t http://localhost:3000/api/webhooks/github
   ```
5. Use the smee.io URL as your GitHub App's webhook URL

### Option 2: ngrok

1. Install ngrok and authenticate
2. Start a tunnel:
   ```bash
   ngrok http 3000
   ```
3. Use the ngrok URL as your webhook URL

### Option 3: GitHub CLI (for testing)

For manual webhook testing:
```bash
gh api /repos/{owner}/{repo}/dispatches \
  -f event_type=test \
  -f client_payload='{"test": true}'
```

## Permissions Reference

### Required Permissions

| Permission | Level | Purpose |
|------------|-------|---------|
| **Metadata** | Read | Identify repos, default branch, collaborators |
| **Contents** | Read & write | Clone repos, create branches, push commits |
| **Issues** | Read & write | Read issue context, post comments |
| **Pull requests** | Read & write | Create PRs, post comments, read state |
| **Checks** | Read & write | Create check runs for agent activity |

### Optional Permissions

| Permission | Level | Purpose |
|------------|-------|---------|
| **Commit statuses** | Read & write | Legacy status API support |
| **Actions** | Read | Read CI run logs for failure analysis |
| **Projects** (org) | Read & write | Update GitHub Projects v2 fields |

## Webhook Events

| Event | Purpose |
|-------|---------|
| `issues` | Track issue creation, updates, assignments |
| `issue_comment` | Capture conversations on issues |
| `pull_request` | Track PR lifecycle (open, close, merge) |
| `pull_request_review` | Track review submissions |
| `push` | Detect branch updates |
| `check_suite` | Track CI status |
| `check_run` | Track individual check results |

## Troubleshooting

### Webhook not received

1. Check the webhook URL is correct
2. Verify the webhook secret matches
3. Check Conductor logs for signature verification errors
4. Use GitHub's webhook delivery history to see payloads and responses

### Permission denied errors

1. Verify the app is installed on the repository
2. Check the installation has the required permissions
3. Regenerate the private key if authentication fails

### Rate limiting

GitHub Apps have higher rate limits than personal tokens:
- 5000 requests/hour for installations
- Conductor includes automatic rate limit handling

## Security Notes

1. **Never commit the private key** to version control
2. **Rotate the webhook secret** periodically
3. **Use environment variables** or a secrets manager
4. **Limit repository access** to only what's needed
5. **Audit webhook deliveries** in GitHub's settings

## Further Reading

- [GitHub Apps Documentation](https://docs.github.com/en/apps)
- [Creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps)
- [Authenticating as a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)
- [Webhook Events and Payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
