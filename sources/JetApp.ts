import { JetBase } from "./JetBase";
import { JetView } from "./JetView";
import { JetViewLegacy } from "./JetViewLegacy";
import { JetViewRaw } from "./JetViewRaw";

import {
	IJetApp, IJetConfig, IJetRouter,
	IJetURL, IJetURLChunk,
	IJetView, IViewConfig, IWebixFacade } from "./interfaces";

import { HashRouter } from "./routers/HashRouter";

import { parse, url2str } from "./helpers";
import "./patch";

// webpack require
declare function require(_$url: string): any;


export class JetApp extends JetBase implements IJetApp {
	public config: IJetConfig;
	public webix: IWebixFacade;

	callEvent: (name: string, parameters: any[]) => boolean;
	attachEvent: (name: string, handler: any) => void;

	private $router: IJetRouter;
	private _view: IJetView;
	private _services: { [name: string]: any };

	constructor(config: any) {
		super();
		this.webix = config.webix || webix;

		// init config
		this.config = this.webix.extend({
			name: "App",
			version: "1.0",
			start: "/home"
		}, config, true);

		this._name = this.config.name;
		this._services = {};

		webix.extend(this, webix.EventSystem);
		webix.attachEvent("onClick", e => this.clickHandler(e));
	}

	getService(name: string) {
		let obj = this._services[name];
		if (typeof obj === "function") {
			obj = this._services[name] = obj(this);
		}
		return obj;
	}
	setService(name: string, handler: any) {
		this._services[name] = handler;
	}

	// copy object and collect extra handlers
	copyConfig(obj: any, target: any, config: IViewConfig) {
		// raw ui config
		if (obj.$ui) {
			obj = { $subview: new JetViewLegacy(this, "", obj) };
		} else if (obj instanceof JetApp){
			obj = { $subview: obj };
		}

		// subview placeholder
		if (obj.$subview) {
			return this.addSubView(obj, target, config);
		}

		// process sub-properties
		target = target || (obj instanceof Array ? [] : {});
		for (const method in obj) {
			let point = obj[method];

			// view class
			if (typeof point === "function" &&
				point.prototype && point.prototype.config) {
				point = { $subview: point };
			}

			if (point && typeof point === "object" &&
				!(point instanceof webix.DataCollection)) {
				if (point instanceof Date) {
					target[method] = new Date(point);
				} else {
					target[method] = this.copyConfig(
						point,
						(point instanceof Array ? [] : {}),
						config);
				}
			} else {
				target[method] = point;
			}
		}

		return target;
	}

	getRouter() {
		return this.$router;
	}

	clickHandler(e: Event) {
		if (e) {
			const target: HTMLElement = (e.target || e.srcElement) as HTMLElement;
			if (target && target.getAttribute) {
				const trigger: string = target.getAttribute("trigger");
				if (trigger) {
					this.trigger(trigger);
				}
				const route: string = target.getAttribute("route");
				if (route) {
					this.show(route);
				}
			}
		}
	}

	refresh(){
		const temp = this._container;
		this._view.destructor();
		this._view = this._container = null;
		this.render(temp, parse(this.getRouter().get()), this._parent);
	}

	loadView(url): Promise<any> {
		const views = this.config.views;
		let result = null;

		try {
			if (views) {
				if (typeof views === "function") {
					// custom loading strategy
					result = views(url);
				} else {
					// predefined hash
					result = views[url];
				}
			} else {
				url = url.replace(/\./g, "/");
				let view = require("jet-views/"+url);
				if (view.__esModule) {
					view = view.default;
				}
				result = view;
			}
		} catch(e){
			result = this._loadError(url, e);
		}

		// custom handler can return view or its promise
		if (!result.then){
			result = Promise.resolve(result);
		}

		// set error handler
		result = result.catch(err => this._loadError(url, err));

		return result;
	}

	createFromURL(url: IJetURLChunk[], now?: IJetView): Promise<IJetView> {
		const chunk = url[0];
		const name = chunk.page;

		let view;
		if (now && now.getName() === name) {
			view = Promise.resolve(now);
		} else {
			view = this.loadView(chunk.page)
				.then(ui => {
					let obj;
					if (typeof ui === "function") {
						if (ui.prototype && ui.prototype.show) {
							// UI class
							obj = new ui(this, name);
						} else {
							// UI factory functions
							obj = new JetViewRaw(this, name, ui());
						}
					} else {
						// UI object
						if (ui.$ui){
							obj = new JetViewLegacy(this, name, ui);
						} else {
							obj = new JetViewRaw(this, name, ui);
						}
					}

					return obj;
				});
		}

		return view;
	}


	// show view path
	show(name: string) {
		if (this.$router.get() !== name) {
			this.canNavigate(name).then(url => {
				this.$router.set(url, { silent:true });
				this._render(url);
			}).catch(() => false);
		}
	}

	canNavigate(url: string, view?:IJetView):Promise<string>{
		const obj = {
			url:parse(url),
			redirect:url,
			confirm: Promise.resolve(true)
		};

		const res = this.callEvent("app:guard", [url, (view || this._view), obj]);
		if (!res){
			return Promise.reject("");
		}

		return obj.confirm.then(() => obj.redirect);
	}

	destructor() {
		this._view.destructor();
	}

	// event helpers
	trigger(name: string, ...rest: any[]) {
		this.apply(name, rest);
	}
	apply(name: string, data: any[]) {
		this.callEvent(name, data);
	}
	action(name: string) {
		return this.webix.bind(function(...rest: any[]) {
			this.apply(name, rest);
		}, this);
	}
	on(name: string, handler) {
		this.attachEvent(name, handler);
	}

	use(plugin, config){
		plugin(this, null, config);
	}

	error(name:string, er:any[]){
		this.callEvent(name, er);
		this.callEvent("app:error", er);

		/* tslint:disable */
		if (this.config.debug){
			if (er[0]){
				console.error(er[0]);
			}
			debugger;
		}
		/* tslint:enable */
	}

	// renders top view
	protected _render(url: string | IJetURL): Promise<IJetView> {
		const firstInit = !this.$router;
		if (firstInit){
			url = this._first_start(url);
		}

		const strUrl = typeof url === "string" ? url : url2str(url);
		return this.canNavigate(strUrl).then(newurl => {
			this.$router.set(newurl, { silent:true });
			return this._render_stage(newurl);
		});
	}

	protected _render_stage(url){
		const parsed = (typeof url === "string") ? parse(url) : url;

		// block resizing while rendering parts of UI
		return (webix.ui as any).freeze(() =>
			this.createFromURL(parsed, this._view).then(view => {
				// save reference for old and new views
				const oldview = this._view;
				this._view = view;

				// render url state for the root
				return view.render(this._container, parsed, this._parent).then(root => {

					// destroy and detack old view
					if (oldview && oldview !== this._view) {
						oldview.destructor();
					}
					if (this._view.getRoot().getParentView()){
						this._container = root;
					}

					this._root = root;

					this.callEvent("app:route", [parsed]);
					return view;
				});
			}).catch(function(er){
				this.error("app:error:render", [er]);
			})
		);
	}

	protected _urlChange(_$url:IJetURL):Promise<any>{
		alert("Not implemented");
		return Promise.resolve(true);
	}

	private _first_start(url: string | IJetURL){
		const cb = a => setTimeout(() => {
			this._render(a);
		},1);
		this.$router = new (this.config.router || HashRouter)(cb, this.config);

		// start animation for top-level app
		if (this._container === document.body && this.config.animation !== false) {
			const node = this._container as HTMLElement;
			webix.html.addCss(node, "webixappstart");
			setTimeout(() => {
				webix.html.removeCss(node, "webixappstart");
				webix.html.addCss(node, "webixapp");
			}, 10);
		}

		if (!url || url.length === 1){
			url = this.$router.get() || this.config.start;
			this.$router.set(url, { silent: true });
		}

		return url;
	}

	// error during view resolving
	private _loadError(url: string, err: Error):any{
		this.error("app:error:resolve", [err, url]);
		return { template:" " };
	}

	private addSubView(obj, target, config:IViewConfig) {
		const url = obj.$subview !== true ? obj.$subview : null;
		const name: string = obj.name || (url ? this.webix.uid() : "default");
		target.id = obj.id || "s" + this.webix.uid();
		const view = config[name] = { id: target.id, url };
		if (view.url instanceof JetView) {
			(view as any).view = view.url;
		}

		return target;
	}
}
