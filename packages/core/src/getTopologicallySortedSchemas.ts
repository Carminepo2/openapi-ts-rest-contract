import { type ReferenceObject, type SchemaObject, isReferenceObject } from "openapi3-ts";

import type { Context } from "./context";
import type { ObjectSchemaMeta } from "./domain/types";

import { circularRefDependencyError } from "./domain/errors";

/**
 * Returns an array of schemas objects sorted in topological order.
 *
 * This function creates a dependency graph of schema components, sorts them topologically.
 * This ensures that if a component depends on another component, the dependent component will be placed after the dependency.
 * So, the components can be generated in the correct order.
 *
 * @param ctx - The context object.
 * @returns  An array of ObjectSchemaMeta objects sorted in topological order.
 */
export function getExportedSchemas(ctx: Context): ObjectSchemaMeta[] {
  const graph = createSchemaComponentsDependencyGraph(ctx);
  const topologicallySortedRefs = topologicalSort(graph);

  return topologicallySortedRefs
    .map((ref) => ctx.componentSchemasMap.get(ref))
    .filter((schema): schema is NonNullable<ObjectSchemaMeta> => schema !== undefined);
}

/**
 * Creates a dependency graph of schema components.
 *
 * This function creates a directed graph of schema components where each vertex is a schema component reference.
 * The graph is represented as an adjacency list.
 *
 * @param ctx - The context object containing the exportedComponentSchemasMap.
 * @returns A dependency graph of schema components.
 */
function createSchemaComponentsDependencyGraph(ctx: Context): Record<string, Set<string>> {
  const graph: Record<string, Set<string>> = {};
  const visitedRefs: Record<string, boolean> = {};

  const getSchemaByRef = ctx.resolveRef<SchemaObject>;
  const schemaComponents = ctx.openAPIDoc.components?.schemas;

  function visit(component: ReferenceObject | SchemaObject, fromRef: string): void {
    if (!(fromRef in graph)) {
      graph[fromRef] = new Set();
    }

    if (isReferenceObject(component)) {
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

/**
 * Performs a topological sort on a directed graph.
 *
 * A topological sort is used here to sort the components in an OpenAPI schema in the correct order.
 * Meaning that if a component depends on another component, the dependent component will be sorted after the dependency.
 * So, the components can be generated in the correct order.
 *
 * @param graph - The graph to sort, represented as an adjacency list.
 * @returns An array of vertices in topologically sorted order.
 *
 * @example
 * const graph = {
 *   a: ['b', 'c'],
 *   b: ['d'],
 *   c: [],
 *   d: []
 * };
 * const sorted = topologicalSort(graph);
 * console.log(sorted); // Output: ['a', 'c', 'b', 'd']
 */
export function topologicalSort(graph: Record<string, Set<string>>): string[] {
  const sorted = new Set<string>();
  const visited: Record<string, boolean> = {};

  function visit(name: string, ancestors: Set<string>): void {
    ancestors.add(name);
    visited[name] = true;

    const node = graph[name] as Set<string>;

    node.forEach((dep) => {
      if (ancestors.has(dep)) {
        // TODO: Handle circular dependencies, for now just throw an error.
        const depsPath = [...Array.from(ancestors), dep];
        throw circularRefDependencyError({ depsPath });
      }
      if (visited[dep]) return;
      visit(dep, ancestors);
    });

    sorted.add(name);
  }

  Object.keys(graph).forEach((name) => {
    visit(name, new Set());
  });

  return Array.from(sorted);
}
