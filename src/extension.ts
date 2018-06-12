/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { PRProvider } from './prView/prProvider';
import { Repository } from './models/repository';
import { Configuration } from './configuration';
import { Resource } from './common/resources';
import { ReviewManager } from './review/reviewManager';
import { CredentialStore } from './credentials';
import { registerCommands } from './commands';
import Logger from './logger';


let repositories: { [key: string]: Repository } = {};


export async function activate(context: vscode.ExtensionContext) {
	// initialize resources
	Resource.initialize(context);

	const config = vscode.workspace.getConfiguration('github');
	const configuration = new Configuration(
		config.get<string>('username'),
		config.get<string>('host'),
		config.get<string>('accessToken')
	);
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(() => {
			const config = vscode.workspace.getConfiguration('github');
			configuration.update(
				config.get<string>('username'),
				config.get<string>('host'),
				config.get<string>('accessToken')
			);
		})
	);

	let credentialStore = new CredentialStore(configuration);
	registerCommands(context); // only register core commands once.

	if (vscode.scm.activeSourceControl) {
		load(context, configuration, vscode.scm.activeSourceControl, credentialStore);
	}

	vscode.scm.onDidChangeActiveSourceControl(e => {
		load(context, configuration, e, credentialStore);
	});
}

async function load(context: vscode.ExtensionContext, configuration: Configuration, activeSourceControl: vscode.SourceControl, credentialStore: CredentialStore) {
	let rootUri = activeSourceControl.rootUri;
	let workspaceFolder = vscode.workspace.getWorkspaceFolder(rootUri);
	Logger.appendLine(`Loading repository in ${workspaceFolder}`);

	let repository = repositories[workspaceFolder.uri.toString()];
	if (!repository) {
		repository = new Repository(workspaceFolder.uri.fsPath);
		let promise = new Promise<void>((resolve, reject) => {
			let dispose = repository.onDidRunGitStatus(e => {
				dispose.dispose();
				resolve();
			});
		});

		await promise;
		await repository.connectGitHub(credentialStore);
		repositories[workspaceFolder.uri.toString()] = repository;
	}

	ReviewManager.initialize(repository);
	PRProvider.initialize(configuration, repository);
}