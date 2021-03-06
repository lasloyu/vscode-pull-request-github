/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { IPullRequest, IPullRequestManager, IPullRequestModel } from './interface';
import { onDidClosePR } from '../commands';
import { exec } from '../common/git';

export class PullRequestOverviewPanel {
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel: PullRequestOverviewPanel | undefined;

	private static readonly _viewType = 'PullRequestOverview';

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionPath: string;
	private _disposables: vscode.Disposable[] = [];
	private _pullRequest: IPullRequestModel;
	private _pullRequestManager: IPullRequestManager;

	public static createOrShow(extensionPath: string, pullRequestManager: IPullRequestManager, pullRequestModel: IPullRequestModel) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
		const title = `Pull Request #${pullRequestModel.prNumber.toString()}`;

		// If we already have a panel, show it.
		// Otherwise, create a new panel.
		if (PullRequestOverviewPanel.currentPanel) {
			PullRequestOverviewPanel.currentPanel._panel.reveal(column);
			PullRequestOverviewPanel.currentPanel._panel.title = title;
		} else {
			PullRequestOverviewPanel.currentPanel = new PullRequestOverviewPanel(extensionPath, column || vscode.ViewColumn.One, title, pullRequestManager);
		}

		PullRequestOverviewPanel.currentPanel.update(pullRequestModel);
	}

	private constructor(extensionPath: string, column: vscode.ViewColumn, title: string, pullRequestManager: IPullRequestManager) {
		this._extensionPath = extensionPath;
		this._pullRequestManager = pullRequestManager;

		// Create and show a new webview panel
		this._panel = vscode.window.createWebviewPanel(PullRequestOverviewPanel._viewType, title, column, {
			// Enable javascript in the webview
			enableScripts: true,

			// And restric the webview to only loading content from our extension's `media` directory.
			localResourceRoots: [
				vscode.Uri.file(path.join(this._extensionPath, 'media'))
			]
		});

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Listen for changes to panel visibility, if the webview comes into view resubmit data
		this._panel.onDidChangeViewState(e => {
			if (e.webviewPanel.visible) {
				this.update(this._pullRequest);
			}
		}, this, this._disposables);

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(message => {
			this._onDidReceiveMessage(message);
		}, null, this._disposables);

		this._pullRequestManager.onDidChangeActivePullRequest(_ => {
			if (this._pullRequestManager && this._pullRequest) {
				const isCurrentlyCheckedOut = this._pullRequest.equals(this._pullRequestManager.activePullRequest);
				this._panel.webview.postMessage({
					command: 'pr.update-checkout-status',
					isCurrentlyCheckedOut: isCurrentlyCheckedOut
				});
			}
		});

		onDidClosePR(pr => {
			if (pr) {
				this._pullRequest.update(pr);
			}

			this._panel.webview.postMessage({
				command: 'update-state',
				state: this._pullRequest.state,
			});
		});
	}

	public async update(pullRequestModel: IPullRequestModel) {
		this._pullRequest = pullRequestModel;
		this._panel.webview.html = this.getHtmlForWebview(pullRequestModel.prNumber.toString());
		const isCurrentlyCheckedOut = pullRequestModel.equals(this._pullRequestManager.activePullRequest);
		const timelineEvents = await this._pullRequestManager.getTimelineEvents(pullRequestModel);
		this._panel.webview.postMessage({
			command: 'pr.initialize',
			pullrequest: {
				number: pullRequestModel.prNumber,
				title: pullRequestModel.title,
				url: pullRequestModel.html_url,
				body: pullRequestModel.body,
				author: pullRequestModel.author,
				state: pullRequestModel.state,
				events: timelineEvents,
				isCurrentlyCheckedOut: isCurrentlyCheckedOut,
				base: pullRequestModel.base && pullRequestModel.base.label || 'UNKNOWN',
				head: pullRequestModel.head && pullRequestModel.head.label || 'UNKNOWN',
				commitsCount: pullRequestModel.commitCount
			}
		});
	}

	private _onDidReceiveMessage(message) {
		switch (message.command) {
			case 'alert':
				vscode.window.showErrorMessage(message.text);
				return;
			case 'pr.checkout':
				vscode.commands.executeCommand('pr.pick', this._pullRequest).then(() => {}, () => {
					const isCurrentlyCheckedOut = this._pullRequest.equals(this._pullRequestManager.activePullRequest);
					this._panel.webview.postMessage({
						command: 'pr.update-checkout-status',
						isCurrentlyCheckedOut: isCurrentlyCheckedOut
					});
				});
				return;
			case 'pr.close':
				vscode.commands.executeCommand<IPullRequest>('pr.close', this._pullRequest);
				return;
			case 'pr.checkout-master':
				// This should be updated for multi-root support and consume the git extension API if possible
				exec(['checkout', 'master'], {
					cwd: vscode.workspace.rootPath
				});
				return;
			case 'pr.comment':
				const text = message.text;
				this._pullRequestManager.createIssueComment(this._pullRequest, text).then(comment => {
					this._panel.webview.postMessage({
						command: 'pr.update-checkout-status',
						value: comment
					});
				});
				return;
		}
	}

	public dispose() {
		PullRequestOverviewPanel.currentPanel = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	private getHtmlForWebview(number: string) {
		const scriptPathOnDisk = vscode.Uri.file(path.join(this._extensionPath, 'media', 'index.js'));
		const scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });
		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Pull Request #${number}</title>
			</head>
			<body>
				<script nonce="${nonce}" src="${scriptUri}"></script>
				<div id="title" class="title"></div>
				<div id="timeline-events" class="discussion" aria-live="polite"></div>
				<div id="comment-form" class="comment-form">
				</div>
			</body>
			</html>`;
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}