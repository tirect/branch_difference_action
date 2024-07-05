import * as core from "@actions/core";
import * as github from "@actions/github";
import * as axios from "axios";

async function run() {
    try {
        const releaseBranch = core.getInput("release-branch", { required: true });
        const previousTag = core.getInput("previous-tag", { required: true });
        const slackWebhookUrl = core.getInput("slack-webhook-url", { required: true });

        if (typeof process.env.STALE_BRANCH_TOKEN === 'undefined') {
            throw new Error('GITHUB_TOKEN environment variable is not defined');
        }
        const octokit = github.getOctokit(process.env.STALE_BRANCH_TOKEN);
        const { owner, repo } = github.context.repo;

        const compareResponse = await octokit.rest.repos.compareCommits({
            owner,
            repo,
            base: previousTag,
            head: releaseBranch,
        });

        const commits = compareResponse.data.commits;

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

        // Send a message for each author
        for (const author in commitsByAuthor) {
            let message = `Commits added to \`${releaseBranch}\` since \`${previousTag}\` by ${author}:\n`;
            for (const commit of commitsByAuthor[author]) {
                message += `\`${commit.sha}\` - ${commit.message}\n`;
            }

            const payload = JSON.stringify({ text: message });

            // Log the message to be sent to Slack
            console.log("Message to be sent to Slack:", message);

            // Send the message to Slack
            await axios.default.post(slackWebhookUrl, payload);
        }
    } catch (error: any) {
        core.setFailed(error.message);
    }
}

run();
