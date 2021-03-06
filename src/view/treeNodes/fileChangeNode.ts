/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DiffHunk } from '../../common/diffHunk';
import { GitChangeType } from '../../common/file';
import { Resource } from '../../common/resources';
import { IPullRequestModel } from '../../github/interface';
import { TreeNode } from './treeNode';
import { Comment } from '../../common/comment';
import { getDiffLineByPosition } from '../../common/diffPositionMapping';

export class FileChangeNode extends TreeNode implements vscode.TreeItem {
	public iconPath?: string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri };
	public resourceUri: vscode.Uri;
	public sha: string;
	public parentSha: string;
	public command?: vscode.Command;
	public comments?: Comment[];
	public contextValue: string;

	get letter(): string {
		switch (this.status) {
			case GitChangeType.MODIFY:
				return 'M';
			case GitChangeType.ADD:
				return 'A';
			case GitChangeType.DELETE:
				return 'D';
			case GitChangeType.RENAME:
				return 'R';
			case GitChangeType.UNKNOWN:
				return 'U';
			default:
				return 'C';
		}
	}

	constructor(
		public readonly pullRequest: IPullRequestModel,
		public readonly label: string,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public blobUrl: string,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public readonly workspaceRoot: string,
		public readonly diffHunks: DiffHunk[]
	) {
		super();
		this.contextValue = 'filechange';
	}

	getTreeItem(): vscode.TreeItem {
		if (this.comments && this.comments.length) {
			this.iconPath = Resource.icons.light.Comment;
		} else {
			this.iconPath = Resource.getFileStatusUri(this);
		}
		this.resourceUri = this.filePath;

		let opts = {};
		if (this.comments && this.comments.length) {
			let sortedActiveComments = this.comments.filter(comment => comment.position).sort((a, b) => {
				return a.position - b.position;
			});

			if (sortedActiveComments.length) {
				let comment = sortedActiveComments[0];
				let diffLine = getDiffLineByPosition(comment.diff_hunks, comment.position === null ? comment.original_position : comment.position);

				if (diffLine) {
					opts = {
						selection: new vscode.Range(diffLine.newLineNumber - 1, 0, diffLine.newLineNumber - 1, 0)
					};
				}
			}
		}

		this.command = {
			title: 'show diff',
			command: 'vscode.diff',
			arguments: [
				this.parentFilePath,
				this.filePath,
				this.fileName,
				opts
			]
		};

		return this;
	}

}