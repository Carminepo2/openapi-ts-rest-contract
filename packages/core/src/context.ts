/* eslint-disable @typescript-eslint/explicit-function-return-type */

import {
  type HeadersObject,
  type ParameterObject,
  type OpenAPIObject,
  type ReferenceObject,
  type RequestBodyObject,
  type ResponseObject,
  type SchemaObject,
  isReferenceObject,
  type ComponentsObject,
} from "openapi3-ts/oas30";
import { formatToIdentifierString, topologicalSort } from "./lib/utils";

const OPEN_API_COMPONENTS_PATH = [
  "schemas",
  "parameters",
  "requestBodies",
  "responses",
  "headers",
] as const;
type OpenAPIComponentPath = (typeof OPEN_API_COMPONENTS_PATH)[number];
type OpenAPIObjectComponent =
  | SchemaObject
  | ParameterObject
  | RequestBodyObject
  | ResponseObject
  | HeadersObject;

export function generateContext(openAPIDoc: OpenAPIObject) {
  const getObjectByRef = <TObjectComponent extends OpenAPIObjectComponent>(
    ref: string,
    depth = 0
  ): TObjectComponent => {
    const { componentPath, componentName } = validateAndParseRef(ref);
    const schemaObject = openAPIDoc.components?.[componentPath]?.[componentName];

    if (!componentName || !schemaObject || depth > 100) {
      throw new Error(`Could not parse component name from ref: ${ref}`);
    }

    if (isReferenceObject(schemaObject)) {
      return getObjectByRef<TObjectComponent>(schemaObject.$ref, depth + 1);
    }

    return schemaObject as TObjectComponent;
  };

  const resolveObject = <TObjectComponent extends OpenAPIObjectComponent>(
    refOrObject: TObjectComponent | ReferenceObject,
    resolvedRefs = new Set<string>()
  ): TObjectComponent => {
    if (!isReferenceObject(refOrObject)) return refOrObject;

    const ref = refOrObject.$ref;
    const component = getObjectByRef<TObjectComponent>(ref);

    if (isReferenceObject(component)) {
      return resolveObject<TObjectComponent>(component, resolvedRefs);
    }

    return component;
  };

  const getSchemaByRef = getObjectByRef<SchemaObject>;

  const graph = createSchemaComponentsDependencyGraph(
    openAPIDoc.components?.schemas,
    getSchemaByRef
  );
  const topologicallySortedSchemaRefs = topologicalSort(graph);

  const schemasToExportMap = new Map<
    string,
    {
      ref: string;
      schema: SchemaObject;
      identifier: string;
      normalizedIdentifier: string;
    }
  >();

  const topologicallySortedSchemas = topologicallySortedSchemaRefs.map((ref) => {
    const { componentName: identifier } = validateAndParseRef(ref);
    const schema = getSchemaByRef(ref);
    const normalizedIdentifier = formatToIdentifierString(identifier);

    const componentMeta = { ref, schema, identifier, normalizedIdentifier };

    // TODO: The schemas should be exported? Or only the ones that are referenced by operations?
    // The current implementation exports all schemas.
    schemasToExportMap.set(ref, componentMeta);
    return componentMeta;
  });

  return {
    openAPIDoc,
    getSchemaByRef,
    getParameterByRef: getObjectByRef<ParameterObject>,
    getRequestBodyByRef: getObjectByRef<RequestBodyObject>,
    getResponseByRef: getObjectByRef<ResponseObject>,
    getHeaderByRef: getObjectByRef<HeadersObject>,

    resolveSchemaObject: resolveObject<SchemaObject>,
    resolveParameterObject: resolveObject<ParameterObject>,
    resolveRequestBodyObject: resolveObject<RequestBodyObject>,
    resolveResponseObject: resolveObject<ResponseObject>,
    resolveHeaderObject: resolveObject<HeadersObject>,

    topologicallySortedSchemas,
    schemasToExportMap,
  };
}

export type Context = ReturnType<typeof generateContext>;

function validateAndParseRef(ref: string): {
  componentPath: OpenAPIComponentPath;
  componentName: string;
} {
  const isValid = OPEN_API_COMPONENTS_PATH.some((componentPath) =>
    ref.startsWith(`#/components/${componentPath}/`)
  );

  if (!isValid) {
    throw new Error(`Invalid reference found: ${ref}`);
  }

  const [
    _, // #/
    __, // components/
    componentPath, // "(schemas|parameters|requestBodies|responses|headers)/"
    componentName,
  ] = ref.split("/") as [string, string, OpenAPIComponentPath, string];

  return {
    componentPath,
    componentName,
  };
}

function createSchemaComponentsDependencyGraph(
  schemaComponents: ComponentsObject["schemas"],
  getSchemaByRef: (ref: string) => SchemaObject
): Record<string, Set<string>> {
  const graph: Record<string, Set<string>> = {};
  const visitedRefs: Record<string, boolean> = {};

  function visit(component: SchemaObject | ReferenceObject, fromRef: string): void {
    if (isReferenceObject(component)) {
      if (!(fromRef in graph)) {
        graph[fromRef] = new Set();
      }

      graph[fromRef].add(component.$ref);

      if (visitedRefs[component.$ref]) return;

      visitedRefs[fromRef] = true;
      visit(getSchemaByRef(component.$ref), component.$ref);
      return;
    }

    (["allOf", "oneOf", "anyOf"] as const satisfies Array<keyof SchemaObject>).forEach((key) => {
      component[key]?.forEach((subComponent) => {
        visit(subComponent, fromRef);
      });
    });

    if (component.type === "array" && component.items) {
      visit(component.items, fromRef);
      return;
    }

    if (component.type === "object" || component.properties || component.additionalProperties) {
      if (component.properties) {
        Object.values(component.properties).forEach((component) => {
          visit(component, fromRef);
        });
      }

      if (component.additionalProperties && typeof component.additionalProperties === "object") {
        visit(component.additionalProperties, fromRef);
      }
    }
  }

  if (schemaComponents) {
    Object.entries(schemaComponents).forEach(([name, schema]) => {
      visit(schema, `#/components/schemas/${name}`);
    });
  }

  return graph;
}