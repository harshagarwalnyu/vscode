/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IExtensionService } from '../../../extensions/common/extensions.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { TestServiceAccessor, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestExtensionService } from '../../../../test/common/workbenchTestServices.js';
import { IFileQuery, QueryType, ISearchResultProvider, SearchProviderType } from '../../common/search.js';
import { SearchService } from '../../common/searchService.js';

suite('SearchService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('fileSearch returns empty for virtual workspace without provider', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables) as TestInstantiationService;
		const accessor = instantiationService.createInstance(TestServiceAccessor);
		const folder = URI.from({ scheme: 'vscode-vfs', path: '/workspace' });
		const fileSystemProvider = disposables.add(new InMemoryFileSystemProvider());
		disposables.add(accessor.fileService.registerProvider(folder.scheme, fileSystemProvider));
		await fileSystemProvider.mkdir(folder);

		// Setup Mock ExtensionService so it doesn't hang waiting for activation
		const extensionService = new class extends TestExtensionService {
			override activationEventIsDone(_activationEvent: string): boolean {
				return true;
			}
			override activateByEvent(_activationEvent: string): Promise<void> {
				return Promise.resolve();
			}
		}();
		instantiationService.stub(IExtensionService, extensionService);

		const searchService = disposables.add(instantiationService.createInstance(SearchService));
		const query: IFileQuery = {
			type: QueryType.File,
			folderQueries: [{ folder }]
		};

		const result = await searchService.fileSearch(query);
		assert.deepStrictEqual(result.results, []);
	});

	test('fileSearch catches provider registered before activation completes', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables) as TestInstantiationService;
		const accessor = instantiationService.createInstance(TestServiceAccessor);
		const folder = URI.from({ scheme: 'file', path: '/workspace' });
		const fileSystemProvider = disposables.add(new InMemoryFileSystemProvider());
		disposables.add(accessor.fileService.registerProvider(folder.scheme, fileSystemProvider));
		await fileSystemProvider.mkdir(folder);

		// Setup Mock ExtensionService
		const onDidChangeExtensionsStatusEmitter = new Emitter<ExtensionIdentifier[]>();
		let activationEventIsDone = false;
		const extensionService = new class extends TestExtensionService {
			override onDidChangeExtensionsStatus = onDidChangeExtensionsStatusEmitter.event;
			override activationEventIsDone(_activationEvent: string): boolean {
				return activationEventIsDone;
			}
			override activateByEvent(_activationEvent: string): Promise<void> {
				return Promise.resolve();
			}
		}();
		instantiationService.stub(IExtensionService, extensionService);

		const searchService = disposables.add(instantiationService.createInstance(SearchService));
		const query: IFileQuery = {
			type: QueryType.File,
			folderQueries: [{ folder }]
		};

		// Start search — will wait for provider via _onDidRegisterProvider or activation event
		const searchPromise = searchService.fileSearch(query);

		// Provider RPC arrives while extension still activating; then activation completes.
		setTimeout(() => {
			activationEventIsDone = true;
			// Register provider first (RPC arrives before activation event fires)
			disposables.add(searchService.registerSearchResultProvider('file', SearchProviderType.file, {
				getAIName: async () => undefined,
				fileSearch: async (_q) => ({ results: [{ resource: folder.with({ path: '/file.txt' }) }], messages: [] }),
				textSearch: async (_q) => ({ results: [], messages: [] }),
				clearCache: async (_k) => { }
			}));
			// Then activation completes
			onDidChangeExtensionsStatusEmitter.fire([]);
		}, 100);

		const result = await searchPromise;
		assert.ok(result.results.length > 0);
	});

	test('fileSearch catches provider registered after activation completes (remote EH race)', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables) as TestInstantiationService;
		const accessor = instantiationService.createInstance(TestServiceAccessor);
		const folder = URI.from({ scheme: 'file', path: '/workspace' });
		const fileSystemProvider = disposables.add(new InMemoryFileSystemProvider());
		disposables.add(accessor.fileService.registerProvider(folder.scheme, fileSystemProvider));
		await fileSystemProvider.mkdir(folder);

		const onDidChangeExtensionsStatusEmitter = new Emitter<ExtensionIdentifier[]>();
		let activationEventIsDone = false;
		const extensionService = new class extends TestExtensionService {
			override onDidChangeExtensionsStatus = onDidChangeExtensionsStatusEmitter.event;
			override activationEventIsDone(_activationEvent: string): boolean { return activationEventIsDone; }
			override activateByEvent(_activationEvent: string): Promise<void> { return Promise.resolve(); }
		}();
		instantiationService.stub(IExtensionService, extensionService);

		const searchService = disposables.add(instantiationService.createInstance(SearchService));
		const query: IFileQuery = { type: QueryType.File, folderQueries: [{ folder }] };

		const searchPromise = searchService.fileSearch(query);

		setTimeout(() => {
			// Activation completes — no provider in map yet
			activationEventIsDone = true;
			onDidChangeExtensionsStatusEmitter.fire([]);
			// Fire-and-forget RPC arrives 50ms later (remote EH latency)
			setTimeout(() => {
				disposables.add(searchService.registerSearchResultProvider('file', SearchProviderType.file, {
					getAIName: async () => undefined,
					fileSearch: async (_q) => ({ results: [{ resource: folder.with({ path: '/file.txt' }) }], messages: [] }),
					textSearch: async (_q) => ({ results: [], messages: [] }),
					clearCache: async (_k) => { }
				}));
			}, 50);
		}, 100);

		const result = await searchPromise;
		assert.ok(result.results.length > 0, 'provider registered after activation should be found within grace period');
	});
});
