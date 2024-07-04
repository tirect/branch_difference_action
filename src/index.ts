import * as core from "@actions/core";
import * as github from "@actions/github";
import * as axios from "axios";

async function run() {
    try {
        const releaseBranch = core.getInput("release-branch", { required: true });
        const previousTag = core.getInput("previous-tag", { required: true });
        const slackWebhookUrl = core.getInput("slack-webhook-url", { required: true });

        if (typeof process.env.GITHUB_TOKEN === 'undefined') {
            throw new Error('GITHUB_TOKEN environment variable is not defined');
        }
        const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
        const { owner, repo } = github.context.repo;

        const compareResponse = await octokit.rest.repos.compareCommits({
            owner,
            repo,
            base: previousTag,
            head: releaseBranch,
        });

        const commits = compareResponse.data.commits;

        let message = `Commits added to \`${releaseBranch}\` since \`${previousTag}\`:\n`;
        for (const commit of commits) {
            const authorName = commit.commit.author?.name ?? "Unknown author";
            message += `\`${commit.sha.substring(0, 7)}\` - ${commit.commit.message} (by ${authorName})\n`;
        }

        const payload = JSON.stringify({ text: message });

        await axios.default.post(slackWebhookUrl, payload);
    } catch (error: any) {
        core.setFailed(error.message);
    }
}

run();
