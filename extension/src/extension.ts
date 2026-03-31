/*
 * Copyright (C) 2017-2020 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { SprottyDiagramIdentifier, SprottyWebview } from 'sprotty-vscode';
import { SprottyLspVscodeExtension, SprottyLspWebview } from 'sprotty-vscode/lib/lsp';
import { commands, extensions, ExtensionContext, Uri, workspace } from 'vscode';
import { LanguageClient, LanguageClientOptions, Location as LSLocation, Position as LSPosition, ServerOptions, StreamInfo } from 'vscode-languageclient/node';

export interface YangExtensionContribution {
    jarPath: string;
    validators?: string[];
}

export interface YangExtensionApi {
    registerExtension(contribution: YangExtensionContribution): void;
}

const contributedJars: YangExtensionContribution[] = [];

function collectPackageJsonContributions(): void {
    for (const ext of extensions.all) {
        const contrib = ext.packageJSON?.["typefox.yang-vscode"]?.extensions;
        if (contrib && Array.isArray(contrib)) {
            for (const entry of contrib) {
                if (entry.jar) {
                    contributedJars.push({
                        jarPath: path.join(ext.extensionPath, entry.jar),
                        validators: entry.validators
                    });
                }
            }
        }
    }
}

function writeContributedSettings(context: ExtensionContext): void {
    if (contributedJars.length === 0) {
        return;
    }

    const separator = os.platform() === 'win32' ? ';' : ':';
    const classpath = contributedJars
        .filter(c => fs.existsSync(c.jarPath))
        .map(c => c.jarPath)
        .join(separator);
    const validators = contributedJars
        .flatMap(c => c.validators ?? [])
        .join(':');

    if (!classpath && !validators) {
        return;
    }

    // Merge contributed extensions into bundled-yang.settings
    const confDir = path.join(context.extensionPath, 'server', 'conf');
    const settingsPath = path.join(confDir, 'bundled-yang.settings');
    let settings: Record<string, any> = {};
    try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch (_) { /* file may not exist yet */ }

    if (!settings.extension) {
        settings.extension = {};
    }
    if (classpath) {
        settings.extension.classpath = classpath;
    }
    if (validators) {
        settings.extension.validators = validators;
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
}

let extension: SprottyLspVscodeExtension | undefined;

export function activate(context: ExtensionContext): YangExtensionApi {
    collectPackageJsonContributions();
    writeContributedSettings(context);

    const api: YangExtensionApi = {
        registerExtension(contribution: YangExtensionContribution): void {
            contributedJars.push(contribution);
        }
    };

    extension = new YangLanguageExtension(context);
    return api;
}

export function deactivate(): Thenable<void> {
    if (!extension) {
        return Promise.resolve();
    }
    const result = extension.deactivateLanguageClient();
    extension = undefined;
    return result;
}

// Use DEBUG true to connect via Socket to server at port: 5008
const DEBUG = process.env.YANG_LS === 'socket';
const SERVER_PORT = 5008;

export class YangLanguageExtension extends SprottyLspVscodeExtension {

    constructor(context: ExtensionContext) {
        super('yang', context);
    }

    protected getDiagramType(): string {
        return 'yang-diagram';
    }

    createWebView(identifier: SprottyDiagramIdentifier): SprottyWebview {
        return new SprottyLspWebview({
            extension: this,
            identifier,
            localResourceRoots: [this.getExtensionFileUri('webview', 'pack')],
            scriptUri: this.getExtensionFileUri('webview', 'pack', 'bundle.js')
        });
    }

    protected activateLanguageClient(context: ExtensionContext): LanguageClient {
        const clientOptions: LanguageClientOptions = {
            documentSelector: ['yang'],
            synchronize: {
                configurationSection: 'yangLanguageServer',
                fileEvents: workspace.createFileSystemWatcher('**/*.yang')
            }
        }
        const clientId = {id: 'yangLanguageServer', name: 'YANG Language Server'};
        const languageClient = DEBUG
            ? getSocketLanguageClient(clientId, clientOptions, SERVER_PORT)
            : getStdioLanguageClient(clientId, clientOptions, context);
        const disposable = languageClient.start()

        commands.registerCommand('yang.show.references', (uri: string, position: LSPosition, locations: LSLocation[]) => {
            commands.executeCommand('editor.action.showReferences',
                Uri.parse(uri),
                languageClient.protocol2CodeConverter.asPosition(position),
                locations.map(languageClient.protocol2CodeConverter.asLocation));
        })

        commands.registerCommand('yang.apply.workspaceEdit', (obj: any) => {
            const edit = languageClient.protocol2CodeConverter.asWorkspaceEdit(obj);
            if (edit) {
                workspace.applyEdit(edit);
            }
        });

        context.subscriptions.push(disposable);
        return languageClient;
    }
}

function getStdioLanguageClient(clientId: {id: string, name: string}, clientOptions: LanguageClientOptions, context: ExtensionContext): LanguageClient {
    const executable = os.platform() === 'win32' ? 'yang-language-server.bat' : 'yang-language-server';
    const serverModule = context.asAbsolutePath(path.join('server', 'bin', executable));

    const serverOptions: ServerOptions = {
        run: {
            command: serverModule,
            options: (os.platform() === 'win32') ? {shell: true} : {}
        },
        debug: {
            command: serverModule,
            options: (os.platform() === 'win32') ? {shell: true} : {},
            args: ['-Xdebug', '-Xnoagent', '-Xrunjdwp:server=y,transport=dt_socket,address=8000,suspend=n,quiet=y', '-Xmx256m']
        }
    }
    return new LanguageClient(clientId.id, clientId.name, serverOptions, clientOptions);
}

function getSocketLanguageClient(clientId: {id: string, name: string}, clientOptions: LanguageClientOptions, serverPort: number): LanguageClient {
    const serverOptions: ServerOptions = () => {
        const socket = net.connect({ port: serverPort });
        const result: StreamInfo = {
            writer: socket,
            reader: socket
        };
        return Promise.resolve(result);
    };
    return new LanguageClient(clientId.id, clientId.name, serverOptions, clientOptions);
}
