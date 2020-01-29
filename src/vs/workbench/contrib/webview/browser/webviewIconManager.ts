/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { memoize } from 'vs/base/common/decorators';
import { URI } from 'vs/base/common/uri';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { WebviewIcons } from 'vs/workbench/contrib/webview/browser/webview';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';

export class WebviewIconManager {

	private readonly _icons = new Map<string, WebviewIcons>();

	constructor(
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IConfigurationService private readonly _configService: IConfigurationService,
	) {
		this._configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('workbench.iconTheme')) {
				this.updateStyleSheet(this._lifecycleService);
			}
		});
	}

	@memoize
	private get _styleElement(): HTMLStyleElement {
		const element = dom.createStyleSheet();
		element.className = 'webview-icons';
		return element;
	}

	public setIcons(
		webviewId: string,
		iconPath: WebviewIcons | undefined,
	) {
		if (iconPath) {
			this._icons.set(webviewId, iconPath);
		} else {
			this._icons.delete(webviewId);
		}

		this.updateStyleSheet(this._lifecycleService);
	}

	private async updateStyleSheet(lifecycleService: ILifecycleService) {
		console.log('update');
		await lifecycleService.when(LifecyclePhase.Starting);

		try {
			const cssRules: string[] = [];
			if (this._configService.getValue('workbench.iconTheme') !== null) {
				this._icons.forEach((value, key) => {
					const webviewSelector = `.show-file-icons .webview-${key}-name-file-icon::before`;
					if (URI.isUri(value)) {
						cssRules.push(`${webviewSelector} { content: ""; background-image: ${dom.asCSSUrl(value)}; }`);
					} else {
						cssRules.push(`.vs ${webviewSelector} { content: ""; background-image: ${dom.asCSSUrl(value.light)}; }`);
						cssRules.push(`.vs-dark ${webviewSelector} { content: ""; background-image: ${dom.asCSSUrl(value.dark)}; }`);
					}
				});
			}
			this._styleElement.innerHTML = cssRules.join('\n');
		} catch {
			// noop
		}
	}
}
