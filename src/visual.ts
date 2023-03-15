import powerbi from "powerbi-visuals-api";
import {FormattingSettingsService} from "powerbi-visuals-utils-formattingmodel";
import "./../style/visual.less";

import {VisualFormattingSettingsModel} from "./settings";
import licenseJson from "../yFiles/license.json";
import {
    Class,
    EdgeSides,
    GraphComponent,
    IGraph,
    ILayoutAlgorithm,
    InteriorLabelModel,
    LayoutExecutor,
    License,
    OrganicEdgeRouter,
    OrganicLayout,
    Rect,
    SequentialLayout,
    Size,
    TextRenderSupport
} from "yfiles";
import {INodeSourceItem} from "./INodeSourceItem";
import {IEdgeSourceItem} from "./IEdgeSourceItem";
import {edgeLabelModel, edgeLabelStyle, edgeStyle, nodeLabelStyle, shapeStyle} from "./styling";
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;

Class.ensure(LayoutExecutor);

export class Visual implements IVisual {

    //region Fields
    /**
     * Root widget host element in which the diagram is placed.
     * @type {HTMLElement}
     */
    private hostElement: HTMLElement;
    /**
     * The yFiles component.
     */
    private graphComponent: GraphComponent;
    /**
     * The settings at design-time.
     * Part of the PowerBI framework.
     * @type {VisualFormattingSettingsModel}
     */
    private formattingSettings: VisualFormattingSettingsModel;
    /**
     * The settings service.
     * Part of the PowerBI framework.
     * @type {FormattingSettingsService}
     */
    private formattingSettingsService: FormattingSettingsService;
    private graph: IGraph;
    /**
     * The mapping from feature name to field names.
     * That is, from the predefined widget features to the dataset field names (if CSV or JSON, the names therein).
     */
    private dataFieldMap: {};
    /**
     * All the id's, corresponding to the raw column of id's.
     * One has multiplicity here but this source is needed to find row indices.
     */
    private nodeIds: string[];
    /**
     * Cached node data.
     */
    private cachedNodeSource: INodeSourceItem[];
    /**
     * Debounces the update method.
     * @type {any}
     */
    timestamp = null;

    /**
     * Cached edge data.
     */
    private cachedEdgeSource: IEdgeSourceItem[];

    /**
     * The node data defining the graph nodes.
     * The id's are unique in here.
     */
    private nodesSource: INodeSourceItem[];

    /**
     * The payload of edges.
     */
    private edgesSource: IEdgeSourceItem[];

    /**
     * Root of the datasets. We use only categorical data for the network creation.
     */
    private data: powerbi.DataView;

    /**
     * The visual host given by PBI.
     */
    private host: powerbi.extensibility.visual.IVisualHost;
    //endregion

    /**
     * Instantiates the visual and sets up the diagram component.
     * The actual construction of the graph happens in the {@link update} method.
     * @param options
     */
    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.formattingSettingsService = new FormattingSettingsService();
        this.hostElement = options.element;
        if (document) {
            this.setLicense()
            this.createGraphComponent()
        }
    }

    /**
     * Sets the yFiles license.
     */
    setLicense() {
        License.value = licenseJson;
    }

    /**
     * Instantiates the yFiles diagram inside the host.
     */
    private createGraphComponent() {
        const div: HTMLDivElement = document.createElement('div');
        div.setAttribute('id', 'graphHost');
        div.style.width = '100%';
        div.style.height = '100%';
        this.hostElement.appendChild(div);
        this.graphComponent = new GraphComponent('#graphHost');
        this.graph = this.graphComponent.graph;
    }


    /**
     * Every time something changes in the edit mode of the widget this method gets called.
     * @param options
     */
    public update(options: VisualUpdateOptions) {

        // a simple debounce
        if (this.timestamp === null) {
            this.timestamp = Date.now() + 1000; // 1secs
        } else {
            if (Date.now() < this.timestamp) {
                return;
            } else {
                this.timestamp = null;
            }
        }
        // no need to render things if there ain;t any data
        if (!options
            || !options.dataViews
            || !options.dataViews[0]
            || (this.graph == null)
        ) {
            return;
        }

        // access to all data
        this.data = options.dataViews[0];

        // access to the formatting options
        this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(VisualFormattingSettingsModel, options.dataViews);

        // we use only categorical data for the graph
        if (!(this.data.categorical && this.data.categorical.categories)) {
            return;
        }
        this.createDataMapping();
        try {
            this.graph.clear();
            this.buildGraph(true);
            this.layout();
        } catch (e) {
            // PowerBI swallows all errors...
            debugger;
        }
    }

    /**
     * Layout of the diagram.
     * You can use the full breadth of yFiles here but for demonstration purposes
     * we'll simply use the organic layout.
     * */
    private layout() {
        const layout = this.createConfiguredLayout(this.graphComponent);
        this.graphComponent.morphLayout(layout);
    }


    /**
     * Creates a basic organic layout with some smooth routing of the edges.
     * @param graphComponent
     * @returns {SequentialLayout}
     */
    createConfiguredLayout(graphComponent: GraphComponent): ILayoutAlgorithm {
        const router = new OrganicEdgeRouter()
        router.minimumDistance = 50
        router.keepExistingBends = false
        router.routeAllEdges = true
        const layout = new SequentialLayout()
        layout.appendLayout(new OrganicLayout({
            minimumNodeDistance: 150
        }));
        layout.appendLayout(router)
        return layout
    }

    /**
     * Assembles the graph using the generated data mappings.
     */
    private buildGraph(updateCache = true) {
        this.nodesSource = this.createNodeSource();
        this.edgesSource = this.createEdgeSource();
        if ((this.nodesSource == null) || this.nodesSource.length === 0) {
            return;
        }
        const nodeDic = {};
        for (let i = 0; i < this.nodesSource.length; i++) {
            const item = this.nodesSource[i];
            const mainLabel = item.label || '';
            const node = this.graph.createNode({
                layout: new Rect(this.graphComponent.size.width / 2, this.graphComponent.size.height / 2, this.graph.nodeDefaults.size.width, this.graph.nodeDefaults.size.height),
                tag: item,
                style: shapeStyle
            });
            // @ts-ignore
            const font = this.graph.getLabelDefaults(node).style.font;

            // adjust the shape's size to the label in it
            let labelMargin = 15;
            let nodeWidth = 50 + labelMargin;
            let nodeHeight = 40 + labelMargin;
            const mainLabelSize = TextRenderSupport.measureText(mainLabel, font);
            // either the shape's width is defined by the label or it's minimum 50, in any case less than 300px
            nodeWidth = mainLabelSize.width + labelMargin;
            nodeHeight = mainLabelSize.height + labelMargin;
            // if the shape is a circle we take the max
            const radius = Math.max(nodeHeight,nodeWidth)
            this.graph.setNodeLayout(node, new Rect(node.layout.toPoint(), new Size(radius,radius)));

            this.graph.addLabel({
                owner: node,
                text: mainLabel,
                style: nodeLabelStyle,
                layoutParameter: InteriorLabelModel.CENTER
            });
            nodeDic[item.id.toString()] = node;
        }

        let edgeLabelSource = this.getCategoricalData('EdgeLabel');
        if ((this.edgesSource == null) || this.edgesSource.length === 0) {
            return;
        }

        let showEdgeLabel = !(edgeLabelSource == null) && edgeLabelSource.length > 0;
        for (let i = 0; i < this.edgesSource.length; i++) {
            try {
                if ((this.edgesSource[i].sourceId == null) || (this.edgesSource[i].targetId == null) || (nodeDic[this.edgesSource[i].sourceId] == null) || (nodeDic[this.edgesSource[i].targetId]) == null) {
                    continue; // happens when the data defines an edge without defining both endpoints
                }
                let s = this.edgesSource[i].sourceId;
                let t = this.edgesSource[i].targetId;

                const edge = this.graph.createEdge({
                    source: nodeDic[s],
                    target: nodeDic[t]
                });
                this.graph.setStyle(edge, edgeStyle);

                if (!(edgeLabelSource == null) && !(edgeLabelSource[i] == null)) {
                    edge.tag = edgeLabelSource[i];
                    if (showEdgeLabel) {
                        const edgeLabelText = edgeLabelSource[i];
                        const edgeLabelLayoutParameter = edgeLabelModel.createParameterFromSource(0, 0.50, EdgeSides.ON_EDGE);

                        const label = this.graph.addLabel(edge, edgeLabelText, edgeLabelLayoutParameter, edgeLabelStyle);
                    }
                }
            } catch (e) {
                debugger
            }
        }
    }
    /**
     * Assembles the node data source for the GraphBuilder.
     */
    private createNodeSource(): INodeSourceItem[] {

        // all the ids corresponding to the rows of edges, you have multiplicity here
        this.nodeIds = this.getCategoricalData('NodeId');

        if ((this.nodeIds == null)) {
            return [];
        }
        const uniqueIds = [...new Set(this.nodeIds)];
        const nodeMainLabels = this.getCategoricalData('NodeMainLabel');
        const nodeShapes = this.getCategoricalData('NodeShape');
        const nodeSource: INodeSourceItem[] = [];
        // creating unique nodes from the unique ids
        for (let i = 0; i < uniqueIds.length; i++) {
            const id = uniqueIds[i].toString();
            // pick up the first row where this id appears
            // supposed all the entity info is the same whenever this id appears, so the first will do
            const rowIndex = this.nodeIds.findIndex(x => x === id);
            const item: INodeSourceItem = {
                id: id,
                label: null,
                shape: null,
                subLabel: null,
                topLabel: null,
                identity: null,
                layerIndex: null
            };
            const categorical = this.data.categorical.categories[0];
            item.identity = this.host.createSelectionIdBuilder()
                .withCategory(categorical, rowIndex)
                .createSelectionId();
            if (nodeMainLabels && i < nodeMainLabels.length) {
                item.label = (nodeMainLabels[rowIndex] == null) ? '' : nodeMainLabels[rowIndex].toString();
            }
            if (nodeShapes && i < nodeShapes.length) {
                item.shape = (nodeShapes[rowIndex] == null) ? null : nodeShapes[rowIndex].toString();
            }

            nodeSource.push(item);
        }
        return nodeSource;
    }

    /**
     * Assembles the given datasets to something yFiles can use with the GraphBuilder.
     */
    private createEdgeSource(): IEdgeSourceItem[] {
        const nodeIds = this.getCategoricalData('NodeId');
        const targetIds = this.getCategoricalData('TargetId');
        if ((targetIds == null) || targetIds.length === 0) {
            return [];
        }

        const edges: IEdgeSourceItem[] = [];
        for (let i = 0; i < nodeIds.length; i++) {
            // null target means no edge towards anything else, which happens e.g. with the root of a tree
            if ((targetIds[i] == null)) {
                continue;
            }
            const item: IEdgeSourceItem = {
                sourceId: nodeIds[i].toString(),
                targetId: targetIds[i].toString()
            };
            edges.push(item)
        }
        return edges;
    }

    /**
     * Fetches the dataset with the given name.
     * @param name
     */
    private getCategoricalData(name): string[] {
        const categoricalFields: string[] = ['NodeId', 'TargetId', 'NodeMainLabel', 'NodeSecondLabel', 'NodeShape', 'EdgeLabel', 'NodeTopLabel'];

        if (!categoricalFields.includes(name, 0)) {
            return null;
        }
        const fieldDefinition = this.dataFieldMap[name];

        if (fieldDefinition == null) {
            return null;
        }
        if (fieldDefinition.isMeasure) // means the data comes from the highlights info
        {
            if (this.data.categorical.values.length > 0) // should always be there based on the PBI framework
            {
                const highlightCollection = this.data.categorical.values[0];
                if (highlightCollection.source.displayName !== fieldDefinition.fieldName) {
                    throw new Error('Something wrong in the highlight logic.')
                }
                return highlightCollection.values as string[];
            }
            return null;
        } else {
            const index = this.getCategoricalIndex(fieldDefinition.fieldName);
            return index < 0 ? null : this.data.categorical.categories[index].values.map(v => (v == null) ? null : v.toString()) as string[];
        }


    }

    /**
     * Maps the given field name to the index of the corresponding category.
     * @param name A field name.
     */
    private getCategoricalIndex(name) {
        if (this.data.categorical.categories.length === 0) {
            return -1;
        }
        const dataset = this.data.categorical.categories;
        for (let i = 0; i < dataset.length; i++) {
            if (dataset[i].source.displayName === name) {
                return i;
            }
        }
        return -1;
    }

    /**
     * The names of the properties are mapped to field names.
     * This dictionary is used later on to pick up the data for a property.
     */
    private createDataMapping() {
        this.dataFieldMap = {};
        for (let i = 0; i < this.data.metadata.columns.length; i++) {
            const roles = this.data.metadata.columns[i].roles;
            for (let k in roles) {

                if (roles[k] === true) {
                    this.dataFieldMap[k] = {
                        fieldName: this.data.metadata.columns[i].displayName,
                        isMeasure: this.data.metadata.columns[i].isMeasure === true
                    };
                }
            }
        }
    }

}
