/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { Emitter, Event } from 'vs/base/common/event';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { IGettingStartedTask, GettingStartedRegistry, IGettingStartedCategory, } from 'vs/workbench/services/gettingStarted/common/gettingStartedRegistry';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { Memento } from 'vs/workbench/common/memento';
import { Action2, registerAction2 } from 'vs/platform/actions/common/actions';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { ContextKeyExpr, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { Disposable } from 'vs/base/common/lifecycle';
import { IUserDataAutoSyncEnablementService } from 'vs/platform/userDataSync/common/userDataSync';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { ExtensionIdentifier, IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { URI } from 'vs/base/common/uri';
import { joinPath } from 'vs/base/common/resources';
import { FileAccess } from 'vs/base/common/network';
import { localize } from 'vs/nls';
import { DefaultIconPath } from 'vs/platform/extensionManagement/common/extensionManagement';

export const IGettingStartedService = createDecorator<IGettingStartedService>('gettingStartedService');

type TaskProgress = { done: boolean; };
export interface IGettingStartedTaskWithProgress extends IGettingStartedTask, TaskProgress { }

export interface IGettingStartedCategoryWithProgress extends Omit<IGettingStartedCategory, 'content'> {
	content:
	| {
		type: 'items',
		items: IGettingStartedTaskWithProgress[],
		done: boolean;
		stepsComplete: number
		stepsTotal: number
	}
	| { type: 'command', command: string }
}

export interface IGettingStartedService {
	_serviceBrand: undefined,

	readonly onDidAddTask: Event<IGettingStartedTaskWithProgress>
	readonly onDidAddCategory: Event<IGettingStartedCategoryWithProgress>

	readonly onDidProgressTask: Event<IGettingStartedTaskWithProgress>

	getCategories(): IGettingStartedCategoryWithProgress[]

	progressByEvent(eventName: string): void;
}

export class GettingStartedService extends Disposable implements IGettingStartedService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidAddTask = new Emitter<IGettingStartedTaskWithProgress>();
	onDidAddTask: Event<IGettingStartedTaskWithProgress> = this._onDidAddTask.event;
	private readonly _onDidAddCategory = new Emitter<IGettingStartedCategoryWithProgress>();
	onDidAddCategory: Event<IGettingStartedCategoryWithProgress> = this._onDidAddCategory.event;

	private readonly _onDidProgressTask = new Emitter<IGettingStartedTaskWithProgress>();
	onDidProgressTask: Event<IGettingStartedTaskWithProgress> = this._onDidProgressTask.event;

	private registry = GettingStartedRegistry;
	private memento: Memento;
	private taskProgress: Record<string, TaskProgress>;

	private commandListeners = new Map<string, string[]>();
	private eventListeners = new Map<string, string[]>();

	private trackedExtensions = new Set<string>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService private readonly contextService: IContextKeyService,
		@IUserDataAutoSyncEnablementService  readonly userDataAutoSyncEnablementService: IUserDataAutoSyncEnablementService,
		@IExtensionService private readonly extensionService: IExtensionService,
	) {
		super();

		this.memento = new Memento('gettingStartedService', this.storageService);
		this.taskProgress = this.memento.getMemento(StorageScope.GLOBAL, StorageTarget.USER);

		this.registry.getCategories().forEach(category => {
			if (category.content.type === 'items') {
				category.content.items.forEach(task => this.registerDoneListeners(task));
			}
		});

		this.extensionService.getExtensions().then(extensions => {
			extensions.forEach(extension => this.registerExtensionContributions(extension));
		});

		this.extensionService.onDidChangeExtensions(() => {
			this.extensionService.getExtensions().then(extensions => {
				extensions.forEach(extension => this.registerExtensionContributions(extension));
			});
		});

		this._register(this.registry.onDidAddCategory(category =>
			this._onDidAddCategory.fire(this.getCategoryProgress(category))
		));

		this._register(this.registry.onDidAddTask(task => {
			this.registerDoneListeners(task);
			this._onDidAddTask.fire(this.getTaskProgress(task));
		}));

		this._register(this.commandService.onDidExecuteCommand(command => this.progressByCommand(command.commandId)));

		this._register(userDataAutoSyncEnablementService.onDidChangeEnablement(() => {
			if (userDataAutoSyncEnablementService.isEnabled()) { this.progressByEvent('sync-enabled'); }
		}));
	}

	private registerExtensionContributions(extension: IExtensionDescription) {
		const convertPaths = (path: string | { hc: string, dark: string, light: string }): { hc: URI, dark: URI, light: URI } => {
			const convertPath = (path: string) => path.startsWith('https://')
				? URI.parse(path, true)
				: FileAccess.asBrowserUri(joinPath(extension.extensionLocation, path));

			if (typeof path === 'string') {
				const converted = convertPath(path);
				return { hc: converted, dark: converted, light: converted };
			} else {
				return {
					hc: convertPath(path.hc),
					light: convertPath(path.light),
					dark: convertPath(path.dark)
				};
			}
		};

		if (!this.trackedExtensions.has(ExtensionIdentifier.toKey(extension.identifier))) {
			this.trackedExtensions.add(ExtensionIdentifier.toKey(extension.identifier));

			if (extension.contributes?.gettingStarted?.length) {
				if (!extension.enableProposedApi) {
					console.warn('Extension', extension.identifier.value, 'contributes getting started content but has not enabled proposedApi. The contributed content will be disregarded.');
					return;
				}

				const categoryID = `EXTContrib-${extension.identifier.value}`;

				this.registry.registerCategory({
					content: { type: 'items' },
					description: localize('extContrib', "Learn more about {0}!", extension.displayName ?? extension.name),
					title: extension.displayName || extension.name,
					id: categoryID,
					icon: {
						type: 'image',
						path: extension.icon
							? FileAccess.asBrowserUri(joinPath(extension.extensionLocation, extension.icon)).toString(true)
							: DefaultIconPath
					},
					when: ContextKeyExpr.true(),
				});
				extension.contributes?.gettingStarted.forEach((content, index) => {
					this.registry.registerTask({
						button: content.button,
						description: content.description,
						media: { type: 'image', altText: content.media.altText, path: convertPaths(content.media.path) },
						doneOn: content.button.command ? { commandExecuted: content.button.command } : { eventFired: `linkOpened:${content.button.link}` },
						id: content.id,
						title: content.title,
						when: ContextKeyExpr.deserialize(content.when) ?? ContextKeyExpr.true(),
						category: categoryID,
						order: index,
					});
				});
			}
		}
	}

	private registerDoneListeners(task: IGettingStartedTask) {
		if (task.doneOn.commandExecuted) {
			const existing = this.commandListeners.get(task.doneOn.commandExecuted);
			if (existing) { existing.push(task.id); }
			else {
				this.commandListeners.set(task.doneOn.commandExecuted, [task.id]);
			}
		}
		if (task.doneOn.eventFired) {
			const existing = this.eventListeners.get(task.doneOn.eventFired);
			if (existing) { existing.push(task.id); }
			else {
				this.eventListeners.set(task.doneOn.eventFired, [task.id]);
			}
		}
	}

	getCategories(): IGettingStartedCategoryWithProgress[] {
		const registeredCategories = this.registry.getCategories();
		const categoriesWithCompletion = registeredCategories
			.filter(category => this.contextService.contextMatchesRules(category.when))
			.map(category => {
				if (category.content.type === 'items') {
					return {
						...category,
						content: {
							type: 'items' as const,
							items: category.content.items.filter(item => this.contextService.contextMatchesRules(item.when))
						}
					};
				}
				return category;
			})
			.filter(category => category.content.type !== 'items' || category.content.items.length)
			.map(category => this.getCategoryProgress(category));
		return categoriesWithCompletion;
	}

	private getCategoryProgress(category: IGettingStartedCategory): IGettingStartedCategoryWithProgress {
		if (category.content.type === 'command') {
			return { ...category, content: category.content };
		}

		const tasksWithProgress = category.content.items.map(task => this.getTaskProgress(task));
		const tasksComplete = tasksWithProgress.filter(task => task.done);

		return {
			...category,
			content: {
				type: 'items',
				items: tasksWithProgress,
				stepsComplete: tasksComplete.length,
				stepsTotal: tasksWithProgress.length,
				done: tasksComplete.length === tasksWithProgress.length,
			}
		};
	}

	private getTaskProgress(task: IGettingStartedTask): IGettingStartedTaskWithProgress {
		return {
			...task,
			...this.taskProgress[task.id]
		};
	}

	private progressTask(id: string) {
		const oldProgress = this.taskProgress[id];
		if (!oldProgress || oldProgress.done !== true) {
			this.taskProgress[id] = { done: true };
			this.memento.saveMemento();
			const task = this.registry.getTask(id);
			this._onDidProgressTask.fire(this.getTaskProgress(task));
		}
	}

	private progressByCommand(command: string) {
		const listening = this.commandListeners.get(command) ?? [];
		listening.forEach(id => this.progressTask(id));
	}

	progressByEvent(event: string): void {
		const listening = this.eventListeners.get(event) ?? [];
		listening.forEach(id => this.progressTask(id));
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'resetGettingStartedProgress',
			category: 'Getting Started',
			title: 'Reset Progress',
			f1: true
		});
	}

	run(accessor: ServicesAccessor) {
		const memento = new Memento('gettingStartedService', accessor.get(IStorageService));
		const record = memento.getMemento(StorageScope.GLOBAL, StorageTarget.USER);
		for (const key in record) {
			if (Object.prototype.hasOwnProperty.call(record, key)) {
				delete record[key];
			}
		}
		memento.saveMemento();
	}
});

registerSingleton(IGettingStartedService, GettingStartedService);
