"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const axios = __importStar(require("axios"));
// Regexes: one for replacement (global) and one for detection (non-global)
// Support both DICE and ARCH ticket identifiers
const JIRA_KEY_RE_G = /\b((?:DICE|ARCH)-[0-9]+)\b/g;
const JIRA_KEY_RE = /\b((?:DICE|ARCH)-[0-9]+)\b/;
const NO_JIRA_MARK = ":x:"; // Use "❌" if you prefer the Unicode emoji
function hasJiraKey(s) {
    return JIRA_KEY_RE.test(s);
}
function escapeSlackText(s) {
    // Escape &, <, > for Slack mrkdwn
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function linkifyJiraKeys(raw, jiraBaseUrls) {
    var _a;
    // Replace keys with <url|KEY>, while escaping everything else
    let out = "";
    let lastIndex = 0;
    for (const m of raw.matchAll(JIRA_KEY_RE_G)) {
        const idx = (_a = m.index) !== null && _a !== void 0 ? _a : 0;
        const key = m[1];
        // escape non-match text
        out += escapeSlackText(raw.slice(lastIndex, idx));
        // Determine which base URL to use based on ticket prefix
        let baseUrl = jiraBaseUrls.default;
        if (key.startsWith("DICE-") && jiraBaseUrls.dice) {
            baseUrl = jiraBaseUrls.dice;
        }
        else if (key.startsWith("ARCH-") && jiraBaseUrls.arch) {
            baseUrl = jiraBaseUrls.arch;
        }
        // insert Slack link
        const url = `${baseUrl.replace(/\/+$/, "")}/browse/${key}`;
        out += `<${url}|${key}>`;
        lastIndex = idx + m[0].length;
    }
    out += escapeSlackText(raw.slice(lastIndex));
    return out;
}
function run() {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const releaseBranch = core.getInput("release-branch", { required: true });
            const previousTag = core.getInput("previous-tag", { required: true });
            const slackWebhookUrl = core.getInput("slack-webhook-url", { required: true });
            // Support separate base URLs for DICE and ARCH, with fallback to a single JIRA_BASE_URL
            const jiraBaseUrlEnv = (process.env.JIRA_BASE_URL || "").trim();
            const jiraBaseUrlDice = (process.env.JIRA_BASE_URL_DICE || "").trim();
            const jiraBaseUrlArch = (process.env.JIRA_BASE_URL_ARCH || "").trim();
            if (!jiraBaseUrlEnv && !jiraBaseUrlDice && !jiraBaseUrlArch) {
                throw new Error("At least one JIRA base URL must be set. Use JIRA_BASE_URL (for both), or JIRA_BASE_URL_DICE and/or JIRA_BASE_URL_ARCH.");
            }
            const jiraBaseUrls = {
                dice: jiraBaseUrlDice || jiraBaseUrlEnv || undefined,
                arch: jiraBaseUrlArch || jiraBaseUrlEnv || undefined,
                default: jiraBaseUrlEnv || jiraBaseUrlDice || jiraBaseUrlArch,
            };
            const teamMappingInput = process.env.TEAM_MAPPING || "";
            let teamMapping = {};
            if (teamMappingInput.trim()) {
                try {
                    teamMapping = JSON.parse(teamMappingInput);
                }
                catch (_c) {
                    throw new Error("TEAM_MAPPING is not valid JSON.");
                }
            }
            if (typeof process.env.STALE_BRANCH_TOKEN === "undefined") {
                throw new Error("STALE_BRANCH_TOKEN environment variable is not defined");
            }
            const octokit = github.getOctokit(process.env.STALE_BRANCH_TOKEN);
            const { owner, repo } = github.context.repo;
            const commits = yield getAllCommits(octokit, owner, repo, previousTag, releaseBranch);
            // Group commits by author
            const commitsByAuthor = {};
            for (const commit of commits) {
                const authorName = (_b = (_a = commit.commit.author) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : "Unknown author";
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
                            const linkified = linkifyJiraKeys(commit.message, jiraBaseUrls);
                            message += `${flagged}\`${commit.sha}\` - ${linkified}\n`;
                        }
                        message += `**********************\n`;
                    }
                }
                if (hasCommits) {
                    message += `\nTeam Lead: ${lead}`;
                    yield sendMessageToSlack(message, slackWebhookUrl);
                    yield sendMessageToSlack("======================\n======================", slackWebhookUrl);
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
                        const linkified = linkifyJiraKeys(commit.message, jiraBaseUrls);
                        unassignedMessage += `${flagged}\`${commit.sha}\` - ${linkified}\n`;
                    }
                }
            }
            if (hasUnassignedCommits) {
                yield sendMessageToSlack(unassignedMessage, slackWebhookUrl);
            }
        }
        catch (error) {
            core.setFailed(error.message);
        }
    });
}
function getAllCommits(octokit, owner, repo, base, head) {
    return __awaiter(this, void 0, void 0, function* () {
        let commits = [];
        let page = 1;
        let response;
        do {
            response = yield octokit.rest.repos.compareCommits({
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
    });
}
function splitMessage(message, maxLength) {
    const messages = [];
    while (message.length > maxLength) {
        let splitIndex = message.lastIndexOf("\n", maxLength);
        if (splitIndex === -1)
            splitIndex = maxLength;
        messages.push(message.substring(0, splitIndex));
        message = message.substring(splitIndex).trim();
    }
    messages.push(message);
    return messages;
}
function sendMessageToSlack(message, webhookUrl) {
    return __awaiter(this, void 0, void 0, function* () {
        // Slack Incoming Webhooks support mrkdwn in `text`
        const messages = splitMessage(message, 4000);
        for (const msg of messages) {
            const payload = JSON.stringify({ text: msg });
            yield axios.default.post(webhookUrl, payload);
        }
    });
}
run();
