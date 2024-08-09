import * as core from "@actions/core";
import * as github from "@actions/github";
import * as axios from "axios";
import { Endpoints } from "@octokit/types";

type CompareCommitsResponse = Endpoints["GET /repos/{owner}/{repo}/compare/{base}...{head}"]["response"]["data"];
type Commit = CompareCommitsResponse["commits"][number];

async function run() {
    try {
        const releaseBranch = core.getInput("release-branch", { required: true });
        const previousTag = core.getInput("previous-tag", { required: true });
        const slackWebhookUrl = core.getInput("slack-webhook-url", { required: true });
        const teamMappingInput = process.env.TEAM_MAPPING || "";

        const teamMapping = JSON.parse(teamMappingInput);

        if (typeof process.env.STALE_BRANCH_TOKEN === 'undefined') {
            throw new Error('GITHUB_TOKEN environment variable is not defined');
        }
        const octokit = github.getOctokit(process.env.STALE_BRANCH_TOKEN);
        const { owner, repo } = github.context.repo;

        const commits = await getAllCommits(octokit, owner, repo, previousTag, releaseBranch);

        // Group commits by author
        const commitsByAuthor: { [key: string]: any[] } = {};
        for (const commit of commits) {
            const authorName = commit.commit.author?.name ?? "Unknown author";
            const commitMessage = commit.commit.message.split("\n")[0]; // Take only the first line
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
            let message = `Commits added to \`${releaseBranch}\` since \`${previousTag}\` by team members of ${teamInfo.team}:\n`;
            let hasCommits = false;
            for (const author of teamInfo.authors) {
                if (commitsByAuthor[author]) {
                    hasCommits = true;
                    message += `Commits by \`${author}\`:\n`;
                    for (const commit of commitsByAuthor[author]) {
                        message += `\`${commit.sha}\` - ${commit.message}\n`;
                    }

                    message += `**********************\n`;
                }
            }
            if (hasCommits) {
                message += `\nTeam Lead: ${lead}`;

                await sendMessageToSlack(message, slackWebhookUrl);
                await sendMessageToSlack("======================\n======================", slackWebhookUrl)
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
                unassignedMessage += `Commits by \`${author}\`:\n`;
                for (const commit of commitsByAuthor[author]) {
                    unassignedMessage += `\`${commit.sha}\` - ${commit.message}\n`;
                }
            }
        }

        if (hasUnassignedCommits) {
            const unassignedPayload = JSON.stringify({ text: unassignedMessage });

            // Send the message to Slack
            await axios.default.post(slackWebhookUrl, unassignedPayload);
        }
    } catch (error: any) {
        core.setFailed(error.message);
    }
}

async function getAllCommits(octokit: ReturnType<typeof github.getOctokit>, owner: string, repo: string, base: string, head: string): Promise<Commit[]> {
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
    const messages = [];
    while (message.length > maxLength) {
        let splitIndex = message.lastIndexOf('\n', maxLength);
        if (splitIndex === -1) splitIndex = maxLength;
        messages.push(message.substring(0, splitIndex));
        message = message.substring(splitIndex).trim();
    }
    messages.push(message);
    return messages;
}

async function sendMessageToSlack(message: string, webhookUrl: string) {
    const messages = splitMessage(message, 4000);
    for (const msg of messages) {
        const payload = JSON.stringify({ text: msg });
        await axios.default.post(webhookUrl, payload);
    }
}

run();
