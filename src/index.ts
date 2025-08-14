import * as core from "@actions/core";
import * as github from "@actions/github";
import * as axios from "axios";
import { Endpoints } from "@octokit/types";

type CompareCommitsResponse = Endpoints["GET /repos/{owner}/{repo}/compare/{base}...{head}"]["response"]["data"];
type Commit = CompareCommitsResponse["commits"][number];

// Regexes: one for replacement (global) and one for detection (non-global)
const JIRA_KEY_RE_G = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;

const NO_JIRA_MARK = ":x:"; // Use "❌" if you prefer the Unicode emoji

function hasJiraKey(s: string): boolean {
  return JIRA_KEY_RE.test(s);
}

function escapeSlackText(s: string): string {
  // Escape &, <, > for Slack mrkdwn
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function linkifyJiraKeys(raw: string, jiraBaseUrl: string): string {
  // Replace keys with <url|KEY>, while escaping everything else
  let out = "";
  let lastIndex = 0;

  for (const m of raw.matchAll(JIRA_KEY_RE_G)) {
    const idx = m.index ?? 0;
    const key = m[1];
    // escape non-match text
    out += escapeSlackText(raw.slice(lastIndex, idx));
    // insert Slack link
    const url = `${jiraBaseUrl.replace(/\/+$/, "")}/browse/${key}`;
    out += `<${url}|${key}>`;
    lastIndex = idx + m[0].length;
  }
  out += escapeSlackText(raw.slice(lastIndex));
  return out;
}

async function run() {
  try {
    const releaseBranch = core.getInput("release-branch", { required: true });
    const previousTag = core.getInput("previous-tag", { required: true });
    const slackWebhookUrl = core.getInput("slack-webhook-url", { required: true });

    const jiraBaseUrlEnv = (process.env.JIRA_BASE_URL || "").trim();
    if (!jiraBaseUrlEnv) {
      throw new Error("JIRA_BASE_URL environment variable is not set. Add it via repo/org Variables.");
    }

    const teamMappingInput = process.env.TEAM_MAPPING || "";
    let teamMapping: Record<string, { team: string; authors: string[] }> = {};
    if (teamMappingInput.trim()) {
      try {
        teamMapping = JSON.parse(teamMappingInput);
      } catch {
        throw new Error("TEAM_MAPPING is not valid JSON.");
      }
    }

    if (typeof process.env.STALE_BRANCH_TOKEN === "undefined") {
      throw new Error("STALE_BRANCH_TOKEN environment variable is not defined");
    }
    const octokit = github.getOctokit(process.env.STALE_BRANCH_TOKEN);
    const { owner, repo } = github.context.repo;

    const commits = await getAllCommits(octokit, owner, repo, previousTag, releaseBranch);

    // Group commits by author
    const commitsByAuthor: { [key: string]: Array<{ sha: string; message: string }> } = {};
    for (const commit of commits) {
      const authorName = commit.commit.author?.name ?? "Unknown author";
      const commitMessage = commit.commit.message.split("\n")[0]; // first line only
      if (!commitsByAuthor[authorName]) {
        commitsByAuthor[authorName] = [];
      }
      commitsByAuthor[authorName].push({
        sha: commit.sha.substring(0, 7),
        message: commitMessage,
      });
    }

    // Send a message for each team lead
    for (const lead in teamMapping) {
      const teamInfo = teamMapping[lead];
      let message = `Commits added to \`${releaseBranch}\` since \`${previousTag}\` by team members of ${escapeSlackText(teamInfo.team)}:\n`;
      let hasCommits = false;

      for (const author of teamInfo.authors) {
        const authorCommits = commitsByAuthor[author];
        if (authorCommits && authorCommits.length) {
          hasCommits = true;
          message += `Commits by \`${escapeSlackText(author)}\`:\n`;
          for (const commit of authorCommits) {
            const flagged = hasJiraKey(commit.message) ? "" : `${NO_JIRA_MARK} `;
            const linkified = linkifyJiraKeys(commit.message, jiraBaseUrlEnv);
            message += `${flagged}\`${commit.sha}\` - ${linkified}\n`;
          }
          message += `**********************\n`;
        }
      }

      if (hasCommits) {
        message += `\nTeam Lead: ${escapeSlackText(lead)}`;
        await sendMessageToSlack(message, slackWebhookUrl);
        await sendMessageToSlack("======================\n======================", slackWebhookUrl);
      }
    }

    // Handle unassigned commits
    let unassignedMessage = `Commits added to \`${releaseBranch}\` since \`${previousTag}\` by unassigned authors:\n`;
    let hasUnassignedCommits = false;

    for (const author in commitsByAuthor) {
      let isAssigned = false;
      for (const lead in teamMapping) {
        if (teamMapping[lead].authors.includes(author)) {
          isAssigned = true;
          break;
        }
      }
      if (!isAssigned) {
        hasUnassignedCommits = true;
        unassignedMessage += `Commits by \`${escapeSlackText(author)}\`:\n`;
        for (const commit of commitsByAuthor[author]) {
          const flagged = hasJiraKey(commit.message) ? "" : `${NO_JIRA_MARK} `;
          const linkified = linkifyJiraKeys(commit.message, jiraBaseUrlEnv);
          unassignedMessage += `${flagged}\`${commit.sha}\` - ${linkified}\n`;
        }
      }
    }

    if (hasUnassignedCommits) {
      await sendMessageToSlack(unassignedMessage, slackWebhookUrl);
    }
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

async function getAllCommits(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<Commit[]> {
  let commits: Commit[] = [];
  let page = 1;
  let response;

  do {
    response = await octokit.rest.repos.compareCommits({
      owner,
      repo,
      base,
      head,
      per_page: 100,
      page,
    });

    commits = commits.concat(response.data.commits);
    page += 1;
  } while (response.data.commits.length === 100);

  return commits;
}

function splitMessage(message: string, maxLength: number): string[] {
  const messages: string[] = [];
  while (message.length > maxLength) {
    let splitIndex = message.lastIndexOf("\n", maxLength);
    if (splitIndex === -1) splitIndex = maxLength;
    messages.push(message.substring(0, splitIndex));
    message = message.substring(splitIndex).trim();
  }
  messages.push(message);
  return messages;
}

async function sendMessageToSlack(message: string, webhookUrl: string) {
  // Slack Incoming Webhooks support mrkdwn in `text`
  const messages = splitMessage(message, 4000);
  for (const msg of messages) {
    const payload = JSON.stringify({ text: msg });
    await axios.default.post(webhookUrl, payload);
  }
}

run();

