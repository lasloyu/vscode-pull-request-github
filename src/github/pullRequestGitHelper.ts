/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Inspired by and includes code from GitHub/VisualStudio project, obtained from https://github.com/github/VisualStudio/blob/165a97bdcab7559e0c4393a571b9ff2aed4ba8a7/src/GitHub.App/Services/PullRequestService.cs
 */

import Logger from '../common/logger';
import { Protocol } from '../common/protocol';
import { Remote } from '../common/remote';
import { Repository } from '../common/repository';
import { IPullRequestModel } from './interface';
import { GitHubRepository } from './githubRepository';

const PullRequestRemoteMetadataKey = 'github-pr-remote';
const PullRequestMetadataKey = 'github-pr-owner-number';
const PullRequestBranchRegex = /branch\.(.+)\.github-pr-owner-number/;

export interface PullRequestMetadata {
	owner: string;
	repositoryName: string;
	prNumber: number;
}

export class PullRequestGitHelper {
	static async createAndCheckout(repository: Repository, pullRequest: IPullRequestModel) {
		let localBranchName = await PullRequestGitHelper.getBranchNameForPullRequest(repository, pullRequest);

		let existing = await repository.getBranch(localBranchName);
		if (existing) {
			// already exist but the metadata is missing.
			Logger.appendLine(`GitHelper> branch ${localBranchName} exists locally but metadata is missing.`)
			await repository.checkout(localBranchName);
		} else {
			// the branch is from a fork
			// create remote for this fork
			Logger.appendLine(`GitHelper> branch ${localBranchName} is from a fork. Create a remote first.`)
			let remoteName = await PullRequestGitHelper.createRemote(repository, pullRequest.head.repositoryCloneUrl);
			// fetch the branch
			let ref = `${pullRequest.head.ref}:${localBranchName}`;
			await repository.fetch(remoteName, ref);
			await repository.checkout(localBranchName);
			// set remote tracking branch for the local branch
			await repository.setTrackingBranch(localBranchName, `refs/remotes/${remoteName}/${pullRequest.head.ref}`);
		}

		let prBranchMetadataKey = `branch.${localBranchName}.${PullRequestMetadataKey}`;
		await repository.setConfig(prBranchMetadataKey, PullRequestGitHelper.buildPullRequestMetadata(pullRequest));
	}

	static async checkout(repository: Repository, remote: Remote, branchName: string, pullRequest: IPullRequestModel): Promise<void> {
		let remoteName = remote.remoteName;
		await repository.fetch(remoteName);
		let branch = await repository.getBranch(branchName);

		if (!branch) {
			Logger.appendLine(`GitHelper> branch ${remoteName}/${branchName} doesn't exist on local disk yet.`);
			await PullRequestGitHelper.fetchAndCreateBranch(repository, remote, branchName, pullRequest);
		}

		await repository.checkout(branchName);

		if (!branch.upstream) {
			// this branch is not associated with upstream yet
			const trackedBranchName = `refs/remotes/${remoteName}/${branchName}`;
			await repository.setTrackingBranch(branchName, trackedBranchName);
		}
		await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest, branchName);
	}

	static async getBranchForPullRequestFromExistingRemotes(repository: Repository, githubRepositories: GitHubRepository[], pullRequest: IPullRequestModel) {
		let headRemote = PullRequestGitHelper.getHeadRemoteForPullRequest(repository, githubRepositories, pullRequest);
		if (headRemote) {
			// the head of the PR is in this repository (not fork), we can just fetch
			return {
				remote: headRemote,
				branch: pullRequest.head.ref
			};
		} else {
			let key = PullRequestGitHelper.buildPullRequestMetadata(pullRequest);
			let configs = await repository.getConfigs();

			let branchInfos = configs.map(config => {
				let matches = PullRequestBranchRegex.exec(config.key);
				return {
					branch: matches && matches.length ? matches[1] : null,
					value: config.value
				};
			}).filter(c => c.branch && c.value === key);

			if (branchInfos && branchInfos.length) {
				let remoteName = await repository.getConfig(`branch.${branchInfos[0].branch}.remote`);
				let headRemote = repository.remotes.filter(remote => remote.remoteName === remoteName);
				if (headRemote && headRemote.length) {
					return {
						remote: headRemote[0],
						branch: branchInfos[0].branch
					};
				}
			}

			return null;
		}
	}

	static async fetchAndCreateBranch(repository: Repository, remote: Remote, branchName: string, pullRequest: IPullRequestModel) {
		let remoteName = remote.remoteName;
		const trackedBranchName = `refs/remotes/${remoteName}/${branchName}`;
		Logger.appendLine(`GitHelper> fetch branch ${trackedBranchName}`);
		const trackedBranch = await repository.getBranch(trackedBranchName);

		if (trackedBranch) {
			// create branch
			await repository.createBranch(branchName, trackedBranch.commit);
			await repository.setTrackingBranch(branchName, trackedBranchName);
		} else {
			throw new Error(`Could not find branch '${trackedBranchName}'.`);
		}
	}

	static buildPullRequestMetadata(pullRequest: IPullRequestModel) {
		return pullRequest.base.repositoryCloneUrl.owner + '#' + pullRequest.base.repositoryCloneUrl.repositoryName + '#' + pullRequest.prNumber;
	}

	static parsePullRequestMetadata(value: string): PullRequestMetadata {
		if (value) {
			let matches = /(.*)#(.*)#(.*)/g.exec(value);
			if (matches && matches.length === 4) {
				const [, owner, repo, prNumber] = matches;
				return {
					owner: owner,
					repositoryName: repo,
					prNumber: Number(prNumber)
				}
			}
		}

		return null;
	}

	static async getMatchingPullRequestMetadataForBranch(repository: Repository, branchName: string): Promise<PullRequestMetadata> {
		let configKey = `branch.${branchName}.${PullRequestMetadataKey}`;
		let configValue = await repository.getConfig(configKey);
		return PullRequestGitHelper.parsePullRequestMetadata(configValue);
	}

	static async createRemote(repository: Repository, cloneUrl: Protocol) {
		Logger.appendLine(`GitHelper> create remote for ${cloneUrl}.`)

		let remotes = repository.remotes;

		remotes.forEach(remote => {
			if (new Protocol(remote.url).equals(cloneUrl)) {
				return remote.repositoryName;
			}
		});

		let remoteName = PullRequestGitHelper.getUniqueRemoteName(repository, cloneUrl.owner);
		await repository.addRemote(remoteName, cloneUrl.normalizeUri().toString());
		await repository.setConfig(`remote.${remoteName}.${PullRequestRemoteMetadataKey}`, 'true');
		return remoteName;
	}

	static async isRemoteCreatedForPullRequest(repository: Repository, remoteName: string) {
		let isForPR = await repository.getConfig(`remote.${remoteName}.${PullRequestRemoteMetadataKey}`);

		if (isForPR === 'true') {
			return true;
		} else {
			return false;
		}
	}

	static async getBranchNameForPullRequest(repository: Repository, pullRequest: IPullRequestModel): Promise<string> {
		let branchName = `pr/${pullRequest.author.login}/${pullRequest.prNumber}`;
		let result = branchName;
		let number = 1;

		while (true) {
			let currentBranch = await repository.getBranch(result);

			if (currentBranch) {
				result = branchName + '-' + number++;
			} else {
				break;
			}
		}

		return result;
	}

	static getUniqueRemoteName(repository: Repository, name: string) {
		let uniqueName = name;
		let number = 1;

		while (repository.remotes.find(e => e.remoteName === uniqueName)) {
			uniqueName = name + number++;
		}

		return uniqueName;
	}

	static getHeadRemoteForPullRequest(repository: Repository, githubRepositories: GitHubRepository[], pullRequest: IPullRequestModel): Remote {
		for (let i = 0; i < githubRepositories.length; i++) {
			let remote = githubRepositories[i].remote;
			if (remote.gitProtocol && remote.gitProtocol.equals(pullRequest.head.repositoryCloneUrl)) {
				return remote;
			}
		}

		return null;
	}

	static async associateBranchWithPullRequest(repository: Repository, pullRequest: IPullRequestModel, branchName: string) {
		Logger.appendLine(`GitHelper> associate ${branchName} with Pull Request #${pullRequest.prNumber}`)
		let prConfigKey = `branch.${branchName}.${PullRequestMetadataKey}`;
		await repository.setConfig(prConfigKey, PullRequestGitHelper.buildPullRequestMetadata(pullRequest));
	}

	static async getLocalBranchesAssociatedWithPullRequest(repository: Repository): Promise<PullRequestMetadata[]> {
		let branches = await repository.getLocalBranches();

		let ret: PullRequestMetadata[] = [];
		for (let i = 0; i < branches.length; i++) {
			let matchingPRMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(repository, branches[i]);
			if (matchingPRMetadata) {
				ret.push(matchingPRMetadata);
			}
		}

		return ret;
	}
}