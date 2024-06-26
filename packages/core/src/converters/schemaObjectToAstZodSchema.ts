import type { Expression } from "typescript";

import { type ReferenceObject, type SchemaObject, isReferenceObject } from "openapi3-ts";
import { P, match } from "ts-pattern";

import type { Context } from "../context/createContext";

import { unexpectedError } from "../domain/errors";
import {
  type TsFunctionCall,
  type TsLiteralOrExpression,
  tsArray,
  tsChainedMethodCall,
  tsIdentifier,
  tsObject,
} from "../lib/ts";
import { generatePowerset } from "../lib/utils";
import {
  type SchemaObjectToZodValidatorsOptions,
  schemaObjectToZodValidators,
} from "./schemaObjectToZodValidators";

type ZodType =
  | "any"
  | "array"
  | "boolean"
  | "enum"
  | "instanceof"
  | "literal"
  | "never"
  | "null"
  | "number"
  | "object"
  | "record"
  | "string"
  | "union"
  | "unknown";

type ZodTypeMethodCall = [zodType: ZodType, ...args: TsLiteralOrExpression[]] | [zodType: ZodType];

/**
 * Builds the ast expression for a Zod schema.
 */
function toZodSchema(
  identifier: Expression | string,
  zodMethod?: ZodTypeMethodCall,
  ...chainedMethods: TsFunctionCall[]
): Expression {
  return tsChainedMethodCall(identifier, ...(zodMethod ? [zodMethod] : []), ...chainedMethods);
}

/**
 * Converts a SchemaObject or ReferenceObject to a Zod schema AST expression.
 *
 * @param schemaOrRef The schema object or reference object to convert.
 * @param ctx The context object.
 * @param validatorOptions Some additional options to pass to the `schemaObjectToZodValidators` function.
 * @returns The AST expression for the Zod schema.
 *
 * @example
 * ```ts
 * const result = schemaObjectToAstZodSchema({
 *    type: "string",
 *    minLength: 2,
 * });
 * console.log(astToString(result)); // Output: z.string().min(2)
 * ```
 */
export function schemaObjectToAstZodSchema(
  schemaOrRef: ReferenceObject | SchemaObject,
  ctx: Context,
  validatorOptions?: SchemaObjectToZodValidatorsOptions
): Expression {
  function toZodSchemaWithValidators(
    identifier: string,
    zodMethod?: ZodTypeMethodCall,
    customValidatorOptions = validatorOptions
  ): Expression {
    return toZodSchema(
      identifier,
      zodMethod,
      ...schemaObjectToZodValidators(schemaOrRef, customValidatorOptions)
    );
  }

  if (isReferenceObject(schemaOrRef)) {
    const exportedSchema = ctx.componentSchemasMap.get(schemaOrRef.$ref);
    /**
     * If the schema is exported, we build the Zod schema from the identifier.
     * Example: `#components/schemas/MySchema` -> `MySchema`
     */
    if (exportedSchema) {
      return toZodSchemaWithValidators(exportedSchema.normalizedIdentifier);
    }
  }

  const schema = ctx.resolveObject(schemaOrRef);

  return match(schema)
    .with({ oneOf: P.nonNullable }, (s) => fromOneOfSchemaObject(s.oneOf, ctx))
    .with({ allOf: P.nonNullable }, (s) => fromAllOfSchemaObject(s.allOf, ctx))
    .with({ anyOf: P.nonNullable }, (s) => fromAnyOfSchemaObject(s.anyOf, ctx))
    .with({ enum: P.nonNullable }, (s) => fromEnumSchemaObject(s, toZodSchemaWithValidators))
    .with(
      { type: P.array(P.any) },
      (s) => s.type.length === 1,
      (s) => schemaObjectToAstZodSchema({ ...schema, type: s.type[0] }, ctx)
    )
    .with(
      { type: P.array(P.any) },
      (s) => s.type.length > 1,
      (s) =>
        toZodSchemaWithValidators("z", [
          "union",
          tsArray(...s.type.map((type) => schemaObjectToAstZodSchema({ ...schema, type }, ctx))),
        ])
    )
    .with(
      { type: "string" },
      () => schema.format === "binary",
      () => toZodSchemaWithValidators("z", ["instanceof", tsIdentifier("File")])
    )
    .with({ type: "string" }, () => toZodSchemaWithValidators("z", ["string"]))
    .with({ type: "number" }, { type: "integer" }, () => toZodSchemaWithValidators("z", ["number"]))
    .with({ type: "boolean" }, () => toZodSchemaWithValidators("z", ["boolean"]))
    .with({ type: "null" }, () => toZodSchemaWithValidators("z", ["null"]))
    .with({ type: "array" }, { items: P.nonNullable }, () =>
      toZodSchemaWithValidators("z", [
        "array",
        !schema.items ? toZodSchema("z", ["any"]) : schemaObjectToAstZodSchema(schema.items, ctx),
      ])
    )
    .with(
      { type: "object" },
      { properties: P.nonNullable },
      { additionalProperties: P.nonNullable },
      () => {
        if (!schema.properties || Object.keys(schema.properties).length === 0) {
          if (schema.additionalProperties === true) {
            return toZodSchemaWithValidators("z", ["record", toZodSchema("z", ["any"])], {
              strict: true,
            });
          }

          if (typeof schema.additionalProperties === "object") {
            return toZodSchemaWithValidators(
              "z",
              ["record", schemaObjectToAstZodSchema(schema.additionalProperties, ctx)],
              { strict: true }
            );
          }
        }
        return toZodSchemaWithValidators("z", [
          "object",
          tsObject(...buildSchemaObjectProperties(schema, ctx)),
        ]);
      }
    )
    .with({ type: P.nullish }, () => toZodSchemaWithValidators("z", ["unknown"]))
    .otherwise((s) => {
      throw unexpectedError({
        detail: `Unsupported schema type:\n${JSON.stringify(s, null, 2)}`,
      });
    });
}

/**
 * Builds the Zod schema for an enum schema object.
 * @example
 * ```ts
 * const schema = {
 *   type: "string",
 *   enum: ["value1", "value2", "value3"]
 * }
 *
 * const result = fromEnumSchemaObject(schema);
 * console.log(astToString(result)); // Output: z.enum(["value1", "value2", "value3"]);
 * ```
 */
function fromEnumSchemaObject(
  schema: SchemaObject,
  buildZodSchemaWithValidators: (
    identifier: string,
    zodMethod?: ZodTypeMethodCall,
    customValidatorOptions?: SchemaObjectToZodValidatorsOptions | undefined
  ) => Expression
): Expression {
  // The check for `schema.enum` is done outside
  const schemaEnum = schema.enum as NonNullable<SchemaObject["enum"]>;

  function resolveEnumValue(value: unknown): string {
    if (value === null) return "null";
    return value as string;
  }

  if (schema.type === "string") {
    if (schemaEnum.length === 1) {
      return buildZodSchemaWithValidators("z", ["literal", resolveEnumValue(schemaEnum[0])]);
    }

    return buildZodSchemaWithValidators("z", [
      "enum",
      tsArray(...schemaEnum.map(resolveEnumValue)),
    ]);
  }

  if (schemaEnum.some((e) => typeof e === "string")) {
    return buildZodSchemaWithValidators("z", ["never"]);
  }

  if (schemaEnum.length === 1) {
    return buildZodSchemaWithValidators("z", ["literal", schemaEnum[0]]);
  }

  return buildZodSchemaWithValidators("z", [
    "enum",
    tsArray(
      ...schemaEnum.map((value) =>
        buildZodSchemaWithValidators("z", ["literal", resolveEnumValue(value)])
      )
    ),
  ]);
}

/**
 * Put all the schemas contained in the `oneOf` property in a zoo `union` method call.
 * @example
 * ```ts
 * const schema = {
 *  oneOf: [
 *     { type: "string" },
 *     { type: "number" },
 *     { type: "boolean" },
 *   ]
 * }
 *
 * const result = buildZodSchemaFromOneOfSchemaObject(schema.oneOf);
 * console.log(astToString(result)); // Output: z.union(z.string(), z.number(), z.boolean())
 * ```
 */
function fromOneOfSchemaObject(
  oneOf: NonNullable<SchemaObject["oneOf"]>,
  ctx: Context
): Expression {
  if (oneOf.length === 1) {
    return schemaObjectToAstZodSchema(oneOf[0], ctx);
  }

  return toZodSchema("z", [
    "union",
    tsArray(...oneOf.map((schema) => schemaObjectToAstZodSchema(schema, ctx))),
  ]);
}

/**
 * Chain all the schemas contained in the `allOf` property with the zod `and` method.
 * @example
 * ```ts
 * const schema = {
 *   allOf: [
 *     { ref: "#/components/schemas/Schema1" },
 *     { ref: "#/components/schemas/Schema2" },
 *     { ref: "#/components/schemas/Schema3" },
 *     { type: "string" },
 *     { type: "boolean" },
 *   ]
 * }
 *
 * const result = buildZodSchemaFromAllOfSchemaObject(schema.allOf);
 * console.log(astToString(result)); // Output: Schema1.and(Schema2).and(Schema3).and(z.string()).and(z.boolean())
 * ```
 */
function fromAllOfSchemaObject(
  allOf: NonNullable<SchemaObject["allOf"]>,
  ctx: Context
): Expression {
  if (allOf.length === 1) {
    return schemaObjectToAstZodSchema(allOf[0], ctx);
  }

  const schemas = allOf.map((s) => schemaObjectToAstZodSchema(s, ctx));

  return toZodSchema(
    schemas[0], // Schema1
    undefined,
    ...schemas.slice(1).map((s) => ["and", s] satisfies TsFunctionCall) // .and(Schema2).and(Schema3) ...
  );
}

/**
 * Creates a zod union of all possible combinations (powerset) of the schemas contained in the `anyOf` property.
 * @example
 * ```ts
 * const schema = {
 *   anyOf: [
 *     { ref: "#/components/schemas/Schema1" },
 *     { ref: "#/components/schemas/Schema2" },
 *   ]
 * }
 *
 * const result = buildZodSchemaFromAnyOfSchemaObject(schema.anyOf);
 * console.log(astToString(result)); // Output: z.union(Schema1.merge(Schema2), Schema2, Schema1)
 * ```
 *
 * @see {@link generatePowerset}
 * @see {@link https://stackblitz.com/edit/typescript-bcarya}
 */
function fromAnyOfSchemaObject(
  anyOf: NonNullable<SchemaObject["anyOf"]>,
  ctx: Context
): Expression {
  if (anyOf.length === 1) {
    return schemaObjectToAstZodSchema(anyOf[0], ctx);
  }

  const schemas = anyOf.map((s) => schemaObjectToAstZodSchema(s, ctx));
  // drop empty set, sort largest to smallest
  const schemasPowerSet = generatePowerset(schemas).slice(1).reverse();
  const subsets = schemasPowerSet.map((set) => {
    if (set.length === 1) return set[0];
    return toZodSchema(
      set[0], // Schema1
      undefined,
      ...set.slice(1).map((s) => ["merge", s] satisfies TsFunctionCall) // .merge(Schema2).merge(Schema3) ...
    );
  });

  return toZodSchema("z", ["union", tsArray(...subsets)]);
}

/**
 * Builds the properties for the Zod object schema from the schema properties.
 */
function buildSchemaObjectProperties(
  schema: SchemaObject,
  ctx: Context
): Array<[string, TsLiteralOrExpression]> {
  if (!schema.properties) return [];

  return Object.entries(schema.properties).map(([key, refOrSchema]) => {
    const isRequired = Boolean(schema.required?.includes(key));
    return [key, schemaObjectToAstZodSchema(refOrSchema, ctx, { isRequired })];
  });
}
