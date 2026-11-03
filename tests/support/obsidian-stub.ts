// A just-enough stand-in for the `obsidian` module, so a test can run the
// real src/settings.ts render code without Obsidian. Only what settings.ts
// and the files it imports touch at runtime is modelled. Everything the
// settings code builds is recorded on the elements and Settings so a test can
// read it back the way a user reads the screen.

export class FakeEl {
	children: FakeEl[] = [];
	settings: FakeSetting[] = [];
	classes = new Set<string>();
	attrs = new Map<string, string>();
	text = "";

	empty(): void {
		this.children = [];
		this.settings = [];
	}
	createDiv(_opts?: unknown): FakeEl {
		return this.createEl("div");
	}
	createSpan(_opts?: unknown): FakeEl {
		return this.createEl("span");
	}
	createEl(_tag: string, opts?: { text?: string; cls?: string }): FakeEl {
		const el = new FakeEl();
		if (opts?.text) el.text = opts.text;
		if (opts?.cls) opts.cls.split(" ").forEach((c) => el.classes.add(c));
		this.children.push(el);
		return el;
	}
	setText(text: string): void {
		this.text = text;
	}
	addClass(...cls: string[]): void {
		cls.forEach((c) => this.classes.add(c));
	}
	removeClass(...cls: string[]): void {
		cls.forEach((c) => this.classes.delete(c));
	}
	toggleClass(cls: string, on: boolean): void {
		if (on) this.classes.add(cls);
		else this.classes.delete(cls);
	}
	setAttr(name: string, value: string): void {
		this.attrs.set(name, value);
	}
	getAttr(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}
	setCssStyles(_styles: unknown): void {}
	addEventListener(_type: string, _cb: unknown): void {}
}

export class FakeToggle {
	value = false;
	onChangeCb: ((value: boolean) => unknown) | null = null;
	setValue(value: boolean): this {
		this.value = value;
		return this;
	}
	onChange(cb: (value: boolean) => unknown): this {
		this.onChangeCb = cb;
		return this;
	}
	/** What a user click does: the control takes the value, then fires onChange. */
	async click(value: boolean): Promise<void> {
		this.value = value;
		await this.onChangeCb?.(value);
	}
}

export class FakeDropdown {
	options: Record<string, string> = {};
	value = "";
	onChangeCb: ((value: string) => unknown) | null = null;
	addOption(key: string, label: string): this {
		this.options[key] = label;
		return this;
	}
	addOptions(options: Record<string, string>): this {
		Object.assign(this.options, options);
		return this;
	}
	setValue(value: string): this {
		this.value = value;
		return this;
	}
	onChange(cb: (value: string) => unknown): this {
		this.onChangeCb = cb;
		return this;
	}
	async select(value: string): Promise<void> {
		this.value = value;
		await this.onChangeCb?.(value);
	}
}

export class FakeText {
	value = "";
	setPlaceholder(_p: string): this {
		return this;
	}
	setValue(value: string): this {
		this.value = value;
		return this;
	}
	onChange(_cb: unknown): this {
		return this;
	}
}

export class FakeButton {
	label = "";
	onClickCb: (() => unknown) | null = null;
	setButtonText(label: string): this {
		this.label = label;
		return this;
	}
	setCta(): this {
		return this;
	}
	setWarning(): this {
		return this;
	}
	setDisabled(_d: boolean): this {
		return this;
	}
	onClick(cb: () => unknown): this {
		this.onClickCb = cb;
		return this;
	}
	setIcon(_i: string): this {
		return this;
	}
	setTooltip(_t: string): this {
		return this;
	}
}

export class FakeSetting {
	name = "";
	desc = "";
	toggles: FakeToggle[] = [];
	dropdowns: FakeDropdown[] = [];
	buttons: FakeButton[] = [];
	nameEl = new FakeEl();
	settingEl = new FakeEl();

	constructor(public containerEl: FakeEl) {
		containerEl.settings.push(this);
	}
	setName(name: string): this {
		this.name = name;
		return this;
	}
	setDesc(desc: string): this {
		this.desc = desc;
		return this;
	}
	setHeading(): this {
		return this;
	}
	setErrorMessage(_m: string | null): this {
		return this;
	}
	addToggle(cb: (t: FakeToggle) => unknown): this {
		const t = new FakeToggle();
		this.toggles.push(t);
		cb(t);
		return this;
	}
	addDropdown(cb: (d: FakeDropdown) => unknown): this {
		const d = new FakeDropdown();
		this.dropdowns.push(d);
		cb(d);
		return this;
	}
	addText(cb: (t: FakeText) => unknown): this {
		cb(new FakeText());
		return this;
	}
	addButton(cb: (b: FakeButton) => unknown): this {
		const b = new FakeButton();
		this.buttons.push(b);
		cb(b);
		return this;
	}
	addExtraButton(cb: (b: FakeButton) => unknown): this {
		cb(new FakeButton());
		return this;
	}
	addComponent(cb: (el: FakeEl) => unknown): this {
		cb(new FakeEl());
		return this;
	}
}

export class SecretComponent {
	constructor(_app: unknown, _el: unknown) {}
	setValue(_v: string): this {
		return this;
	}
	onChange(_cb: unknown): this {
		return this;
	}
}

export class PluginSettingTab {
	containerEl = new FakeEl();
	constructor(
		public app: unknown,
		_plugin: unknown
	) {}
}

export { FakeSetting as Setting };

export const requestUrl = (): never => {
	throw new Error("requestUrl is not available in the obsidian stub");
};
