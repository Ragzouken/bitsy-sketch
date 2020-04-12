import * as Pixi from 'pixi.js';
import { v4 as uuid } from 'uuid';
import { Drawing } from '../data/Drawing';
import { HitPrecision, pageFirstObjectUnderPoint } from '../data/PositionedDrawing';
import { Scene, SceneObject, ScriptPage, Comparison, ScriptCondition } from '../data/Scene';
import ModelViewMapping from '../tools/ModelViewMapping';
import * as utility from '../tools/utility';
import DialogueView from './DialogueView';
import FlicksyEditor from './FlicksyEditor';
import Panel from './Panel';
import PositionedDrawingView from './PositionedDrawingView';
import { FlicksyVariable } from '../data/FlicksyProject';
import ScriptPageEditor from './ScriptPageEditor';
import { DialogueRenderer } from './DialogueRenderer';
import { MAGENTA_CANVAS_4X4 } from 'blitsy';

export type SceneObjectView = PositionedDrawingView<SceneObject>;


function preprocessVariablesHack(
    variables: FlicksyVariable[], 
    script: string
): string {
    const pattern = /{=([^}]+)}/;

    while (script.match(pattern)) {
        script = script.replace(pattern, (_: string, name: string) => {
            const variable = variables.find(v => v.name === name);
            return variable ? variable.value.toString() : "UNSET VARIABLE";
        });
    }

    return script;
}

export default class ScenesPanel implements Panel
{
    public get activeScene(): Scene { return this.scene }

    public selected: SceneObject | undefined;
    public selectedScriptPage: ScriptPage | undefined;

    private readonly container: Pixi.Container;
    private readonly overlayContainer: Pixi.Container;
    private readonly objectContainer: Pixi.Container;
    
    private readonly mask: Pixi.Graphics;
    private readonly bounds: Pixi.Graphics;

    private readonly objectViews: ModelViewMapping<SceneObject, SceneObjectView>;

    private scene: Scene;

    private dragOrigin: Pixi.Point;
    private draggedObject: SceneObjectView | undefined;
    
    private readonly sceneNameHeading: HTMLElement;

    // selected object ui
    private readonly objectSection: HTMLDivElement;
    private readonly objectNameInput: HTMLInputElement;
    private readonly objectDeleteButton: HTMLButtonElement;
    
    private readonly objectDialoguePreview: DialogueView;
    private readonly dialogueRenderer: DialogueRenderer;
    private readonly dialogueSprite: Pixi.Sprite;
    public previewingDialogue: boolean;

    // script page ui
    private readonly scriptPageSelect: HTMLSelectElement;
    private readonly scriptPageEditor: ScriptPageEditor;

    private playModeTest: boolean;
    public playModeVariables: FlicksyVariable[] = [];

    public constructor(public readonly editor: FlicksyEditor)
    {
        this.objectViews = new ModelViewMapping<SceneObject, SceneObjectView>(
            () => this.createSceneObjectView(),
            (view, active) => view.root.visible = active  
        );

        this.container = new Pixi.Container();
        editor.pixi.stage.addChild(this.container);
        this.objectContainer = new Pixi.Container();
        this.container.addChild(this.objectContainer);
        this.overlayContainer = new Pixi.Container();
        this.container.addChild(this.overlayContainer);

        this.objectDialoguePreview = new DialogueView(editor);
        this.dialogueRenderer = new DialogueRenderer(MAGENTA_CANVAS_4X4,
                                                     MAGENTA_CANVAS_4X4,
                                                     3);
        this.dialogueSprite = new Pixi.Sprite(this.dialogueRenderer.texture);
        this.overlayContainer.addChild(this.objectDialoguePreview.container);
        this.overlayContainer.addChild(this.dialogueSprite);

        this.container.interactive = true;
        // set with project
        // this.container.hitArea = new Pixi.Rectangle(0, 0, 160, 100);
        // this.container.pivot = new Pixi.Point(80, 50);

        this.mask = new Pixi.Graphics();
        // set with project
        // this.mask.beginFill(0x000000);
        // this.mask.drawRect(0, 0, 160, 100);
        this.container.addChild(this.mask);
        this.objectContainer.mask = this.mask;

        // scene bounds
        this.bounds = new Pixi.Graphics();
        // set with project
        // this.bounds.lineStyle(1, 0xFFFFFF);
        // this.bounds.drawRect(-.5, -.5, 160 + 1, 100 + 1);
        this.bounds.alpha = 1;
        this.overlayContainer.addChild(this.bounds);

        utility.buttonClick("scene-view-in-map-button", () => 
        {
            this.editor.openSceneMap(this.scene);
        });

        this.objectSection = utility.getElement("selected-object-section");
        this.sceneNameHeading = utility.getElement("scene-tab-scene-name");

        utility.buttonClick("object-higher", () => this.shiftSelectedObjectUp());
        utility.buttonClick("object-lower", () => this.shiftSelectedObjectDown());

        utility.buttonClick("create-object-drawing-picker-button", () => this.createObjectFromPicker());
        utility.buttonClick("object-pick-drawing-button", () => this.startPickingSelectedObjectDrawing());

        this.objectNameInput = utility.getElement("object-name");
        this.objectDeleteButton = utility.getElement("delete-object-button");

        this.objectNameInput.addEventListener("input", () => 
        {
            if (this.selected) { this.selected.name = this.objectNameInput.value; }
        });

        this.objectDeleteButton.addEventListener("click", () =>
        {
            if (this.selected) { this.removeObject(this.selected); }
        });

        this.select(undefined);

        this.container.on("pointerdown", (event: Pixi.interaction.InteractionEvent) => this.onPointerDown(event));
        this.container.on("pointermove", (event: Pixi.interaction.InteractionEvent) => this.onPointerMove(event));
        this.container.on("pointerup",        (event: Pixi.interaction.InteractionEvent) => this.stopDragging());
        this.container.on("pointerupoutside", (event: Pixi.interaction.InteractionEvent) => this.stopDragging());
    
        const createPage = () => ({
            name: "", 
            condition: {source: "", check: "==" as Comparison, target: ""},
            variableChanges: [],
            dialogue: "",
        });

        // script pages
        utility.buttonClick("object-script-page-create", () =>
        {
            if (this.selected)
            {
                const page = createPage();
                this.selected.scriptPages.splice(this.selected.scriptPages.length - 1, 0, page);
                this.selectedScriptPage = page;
                this.refresh();
            }
        });

        this.scriptPageSelect = utility.getElement("object-script-page-select");
        this.scriptPageSelect.addEventListener("change", () =>
        {
            if (this.selected)
            {
                const index = this.scriptPageSelect.selectedIndex;
                const page = this.selected.scriptPages[index];

                this.selectScriptPage(page);
                this.refresh();
            }
        });

        this.scriptPageEditor = new ScriptPageEditor(this, () => { 
            this.showDialogue(this.selectedScriptPage!);
        });

        this.editor.pixi.ticker.add(dt => {
            if (!this.playModeTest)
                this.dialogueRenderer.revealAll();
            this.dialogueRenderer.update(dt / 60);
            this.dialogueRenderer.render();
        });
    }

    public show(): void
    {
        this.hideDialogue();
        this.container.visible = true;
        document.getElementById("scene-sidebar")!.hidden = false;
        this.refresh();
    }

    public hide(): void
    {
        this.container.visible = false;
        document.getElementById("scene-sidebar")!.hidden = true;
    }

    public setPlayTestMode(on: boolean): void
    {
        this.hideDialogue();
        this.playModeTest = on;
        this.select(undefined);
        this.selectScriptPage(undefined);
        this.refresh();
    }

    public onDialogueEnded(): void
    {
        this.hideDialogue();
        this.doQueuedSceneChange();
    }

    public hideDialogue(): void
    {
        this.previewingDialogue = false;
        this.dialogueRenderer.cancel();
        this.refresh();
    }

    public showDialogue(page: ScriptPage): void
    {
        this.selectedScriptPage = page;
        this.previewingDialogue = true;

        const script = preprocessVariablesHack(this.playModeVariables, page.dialogue);

        this.dialogueRenderer.cancel();
        this.dialogueRenderer.queueScript(script);

        this.refresh();
    }

    /** Resynchronise this display to the data in the underlying Scene */
    public refresh(): void
    {
        this.refreshObjectViews();
        this.refreshBounds();

        this.sceneNameHeading.innerText = `scene: ${this.scene.name}`;

        const scenes = this.editor.project.scenes.map(scene => ({ label: `go to: ${scene.name}`, value: scene.uuid }));
        scenes.splice(0, 0, { label: "nothing", value: "" });

        this.select(this.selected);
        this.selectScriptPage(this.selectedScriptPage);

        // dialogue preview
        this.refreshDialogue();
    }

    private refreshDialogue(): void
    {
        const showDialogue = this.previewingDialogue
                          && !this.dialogueRenderer.empty;

        this.dialogueRenderer.render();

        const [width, height] = this.editor.resolution;
        const scale = .5;

        const dw = this.dialogueSprite.texture.width * scale;
        const dh = this.dialogueSprite.texture.height * scale;

        this.dialogueSprite.width = dw;
        this.dialogueSprite.height = dh;

        const x = Math.floor((width - dw) / 2);
        const y = Math.floor(height - (height/2 - dh)/2 - dh);

        this.dialogueSprite.position.set(x, y);
        this.dialogueSprite.visible = showDialogue;

        this.objectDialoguePreview.container.visible = showDialogue;
    }

    /** Switch the currently selected object, or select nothing if undefined */
    public select(object: SceneObject | undefined): void
    {
        const change = this.selected !== object;
        
        this.selected = object;

        if (change)
        {
            if (object && object.scriptPages.length > 0)
            {
                this.selectScriptPage(object.scriptPages[0]);
            }
            else
            {
                this.selectScriptPage(undefined);
            }
        }

        this.objectViews.forEach(view => view.setSelected(view.object === object));

        this.objectSection.hidden = !object;

        if (object)
        {
            this.objectNameInput.value = object.name;

            const makeLabel = (page: ScriptPage) =>
            {
                if (page.name.length > 0) return page.name;

                const source = this.editor.project.variables.find(v => v.uuid === page.condition.source);
                const target = this.editor.project.variables.find(v => v.uuid === page.condition.target);

                if (source && target && page.condition.check !== "pass")
                {
                    return `${source.name} ${page.condition.check} ${target.name}`;
                }

                return "unconditional";
            }

            // script pages
            const options = object.scriptPages.map((page, i) => ({
                 label: `${i+1}. ${makeLabel(page)}`, value: i.toString() }));

            utility.repopulateSelect(this.scriptPageSelect, options);
            this.scriptPageSelect.value = "0";
        }
        else
        {
            this.objectDialoguePreview.container.visible = false;
        }
    }

    public deleteScriptPage(page: ScriptPage): void
    {
        if (this.selected)
        {
            const index = this.selected.scriptPages.indexOf(page);

            if (index < this.selected.scriptPages.length - 1)
            {
                this.selected.scriptPages.splice(index, 1);
                this.refresh();
                this.selectScriptPage(this.selected.scriptPages[0]);
            }
        }
    }

    public selectScriptPage(page: ScriptPage | undefined): void
    {
        const root = utility.getElement("selected-script-page");
        root.hidden = page === undefined;

        this.selectedScriptPage = page;

        if (page)
        {
            this.scriptPageEditor.setState(this.editor.project, page);
        }

        if (this.selected)
        {
            const value = page ? this.selected.scriptPages.indexOf(page).toString() : "-1";
            this.scriptPageSelect.value = value;
        }
    }

    public removeObject(object: SceneObject)
    {
        if (object === this.selected)
        {
            this.select(undefined);
            this.selectScriptPage(undefined);
        }

        this.scene.removeObject(object);
        this.refreshObjectViews();
    }

    public setScene(scene: Scene): void
    {
        this.scene = scene;
        this.select(undefined);
        this.refresh();
    }

    public createObject(drawing: Drawing): SceneObject
    {
        const object = new SceneObject();
        object.uuid = uuid();
        object.name = `object ${this.activeScene.objects.length}`;
        object.dialogue = "";
        object.drawing = drawing;

        const cx = Math.floor(drawing.width / 2);
        const cy = Math.floor(drawing.height / 2);

        object.position = new Pixi.Point(80 - cx, 50 - cy);
        object.scriptPages.push({
            name: "unconditional", 
            condition: {check:"pass", source:"", target:""},
            variableChanges: [],
            dialogue:"",
        });

        this.scene.addObject(object);

        this.select(object);
        this.refresh();

        return object;
    }

    public updateDragging(event: Pixi.interaction.InteractionEvent): void
    {
        if (this.draggedObject)
        {
            const position = utility.round(utility.add(this.dragOrigin, event.data.getLocalPosition(this.overlayContainer)));

            this.draggedObject.object.position = position;
            this.draggedObject.root.position = position;
        }
    }

    private isObjectInteractable(object: SceneObject): boolean
    {
        const page = this.getFirstValidPage(object);
        
        if (!page) return false;
        
        return page.dialogue.length > 0
            || page.sceneChange !== undefined
            || page.variableChanges.length > 0;
    }

    private getFirstValidPage(object: SceneObject): ScriptPage | undefined
    {
        type cmp = (a: number, b: number) => boolean;

        const checks: {[name: string]: cmp} = {
            "==": (a, b) => a === b,
            ">=": (a, b) => a >=  b,
            "<=": (a, b) => a <=  b,
            ">":  (a, b) => a >   b,
            "<":  (a, b) => a <   b,
        };

        const checkCondition = (condition: ScriptCondition) =>
        {
            const source = this.playModeVariables.find(v => v.uuid === condition.source);
            const target = this.playModeVariables.find(v => v.uuid === condition.target);

            return !source || !target || checks[condition.check](source.value, target.value); 
        };

        const page = object.scriptPages.find(page => checkCondition(page.condition));

        return page;
    }

    private queuedSceneChange: string | undefined;

    private doQueuedSceneChange(): void
    {
        if (!this.playModeTest) this.queuedSceneChange = undefined;

        if (this.queuedSceneChange)
        {
            this.setScene(this.editor.project.getSceneByUUID(this.queuedSceneChange)!);
            this.setPlayTestMode(true);
            this.queuedSceneChange = undefined;
        }
    }

    private testRunObjectScripts(object: SceneObject): void
    {
        // old style object
        if (object.sceneChange && object.scriptPages.length === 0)
        {
            this.setScene(this.editor.project.getSceneByUUID(object.sceneChange)!);
            this.setPlayTestMode(true);
        }

        const page = this.getFirstValidPage(object);

        if (page)
        {
            for (let change of page.variableChanges)
            {
                const source = this.playModeVariables.find(v => v.uuid === change.source);
                const target = this.playModeVariables.find(v => v.uuid === change.target);

                if (source && target)
                {
                    if (change.action === "+=")
                    {
                        source.value += target.value;
                    }
                    else if (change.action === "-=")
                    {
                        source.value -= target.value;
                    }
                    else if (change.action === "=")
                    {
                        source.value = target.value;
                    }
                }
                else
                {
                    console.log("Ignoring variable change, invalid variables");
                }
            }

            this.queuedSceneChange = page.sceneChange;

            if (page.dialogue.length > 0)
            {
                this.showDialogue(page);
            }
            else
            {
                this.doQueuedSceneChange();
            }
        }
    }

    private onPointerDown(event: Pixi.interaction.InteractionEvent): void
    {
        if (this.previewingDialogue)
        {
            if (this.dialogueRenderer.empty) {
                this.onDialogueEnded();
            } else {
                this.dialogueRenderer.skip();
                this.refreshDialogue();
                if (this.dialogueRenderer.empty) this.onDialogueEnded();
            }

            event.stopPropagation();
            return;
        }

        const page = utility.floor(event.data.getLocalPosition(this.objectContainer));
        const object = pageFirstObjectUnderPoint(this.scene.objects, page, HitPrecision.Pixel);
        
        if (!object) 
        {
            this.select(undefined); 
            return; 
        }

        if (this.playModeTest)
        {
            this.testRunObjectScripts(object);
        }
        else
        {
            this.startDragging(this.objectViews.get(object)!, event);
        }

        event.stopPropagation();
    }

    private onPointerMove(event: Pixi.interaction.InteractionEvent): void
    {
        const page = utility.floor(event.data.getLocalPosition(this.objectContainer));
        const object = pageFirstObjectUnderPoint(this.scene.objects, page, HitPrecision.Pixel);
        
        this.objectViews.forEach(v => v.hover.visible = false);

        if (object)
        {
            this.objectViews.get(object)!.hover.visible = !this.playModeTest;
            
            if (this.playModeTest)
            {
                this.container.cursor = this.isObjectInteractable(object) 
                                      ? "pointer" 
                                      : "initial";
            }
            else
            {
                this.container.cursor = "grab";
            }
        }
        else
        {
            this.container.cursor = "initial";
        }
    }

    private shiftSelectedObjectUp(): void
    {
        if (this.selected)
        {
            const index = this.scene.objects.indexOf(this.selected);
            
            utility.swapArrayElements(this.scene.objects, index, index + 1);
            this.refresh();
        }
    }

    private shiftSelectedObjectDown(): void
    {
        if (this.selected)
        {
            const index = this.scene.objects.indexOf(this.selected);
            
            utility.swapArrayElements(this.scene.objects, index, index - 1);
            this.refresh();
        }
    }

    private createObjectFromPicker(): void 
    {
        this.editor.drawingBoardsPanel.show();
        this.hide();
        this.editor.drawingBoardsPanel.pickDrawingForScene(drawing => 
        {
            if (drawing) 
            {
                this.createObject(drawing);
            }
            
            this.editor.drawingBoardsPanel.hide();
            this.show();
        }, `pick a drawing for a new object in the scene <em>${this.scene.name}</em>`);
    }

    /**
     * 
     */
    private endPickingSelectedObjectDrawing(drawing: Drawing | undefined): void
    {
        if (drawing && this.selected)
        {
            this.selected.drawing = drawing;
        }

        this.show();
    }

    /**
     * Open the drawing picker to select a drawing to use for the currently
     * selected SceneObject
     */
    private startPickingSelectedObjectDrawing(): void 
    {
        if (!this.selected) { return; }

        const context = `pick the drawing for the object <em>${this.selected.name}</em> in the scene <em>${this.scene.name}</em>`;

        this.hide();
        this.editor.drawingBoardsPanel.pickDrawingForScene(drawing => this.endPickingSelectedObjectDrawing(drawing), context);
    }

    public changeScriptPageSceneChangeFromPicker(): void 
    {
        if (!this.selected || !this.selectedScriptPage) { return; }

        const pin = this.editor.project.sceneBoards[0].pins.find(p => p.element.uuid === this.selectedScriptPage!.sceneChange);

        this.editor.sceneMapsPanel.select(pin);
        this.editor.sceneMapsPanel.show();
        this.hide();
        this.editor.sceneMapsPanel.pickSceneForObject(scene =>
        {
            if (scene && this.selected && this.selectedScriptPage)
            {
                this.selectedScriptPage.sceneChange = scene.uuid;
            }

            this.editor.drawingBoardsPanel.hide();
            this.show();
        }, `pick the scene to got to after clicking the object <em>${this.selected.name}</em> in the scene <em>${this.scene.name}</em>`,
        this.selected);
    }


    private createSceneObjectView(): SceneObjectView
    {
        const view = new PositionedDrawingView<SceneObject>();
        view.root.interactive = false;

        this.objectContainer.addChild(view.root);

        return view;
    }

    private refreshObjectViews(): void
    {
        this.objectViews.setModels(this.scene.objects);
        this.objectViews.forEach(view => view.border.visible = false);
        this.objectViews.refresh();
        
        // reorder the sprites
        this.scene.objects.forEach((object, index) => 
        {
            this.objectContainer.setChildIndex(this.objectViews.get(object)!.root, index);
        });
    }

    private stopDragging(): void
    {
        this.draggedObject = undefined;
    }

    private startDragging(view: SceneObjectView, event: Pixi.interaction.InteractionEvent): void
    {
        this.stopDragging();

        this.draggedObject = view;
        this.dragOrigin = utility.sub(view.root.position, event.data.getLocalPosition(this.overlayContainer));

        this.select(view.object);
    }

    private refreshBounds(): void
    {
        const [width, height] = this.editor.project.resolution;

        this.container.pivot = new Pixi.Point(width / 2, height / 2);
        this.container.hitArea = new Pixi.Rectangle(0, 0, width, height);

        this.mask.clear();
        this.mask.beginFill(0x000000);
        this.mask.drawRect(0, 0, width, height);

        this.bounds.clear();
        this.bounds.lineStyle(1, 0xFFFFFF);
        this.bounds.drawRect(-.5, -.5, width + 1, height + 1);
        this.bounds.alpha = 1;

        this.objectDialoguePreview.refreshBounds();
    }
}
