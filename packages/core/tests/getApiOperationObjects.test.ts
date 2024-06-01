import { createContext } from "../src/context";
import { invalidHttpMethodError, invalidStatusCodeError } from "../src/domain/errors";
import { getApiOperationObjects } from "../src/getApiOperationObjects";

const openAPIMock = {
  info: {
    title: "test",
    version: "3.0",
  },
  openapi: "3.0",
};

describe("getApiOperationObjects", () => {
  it("should return an array of APIOperationObject", () => {
    const ctx = createContext({
      ...openAPIMock,
      paths: { "/hello": { get: { responses: { 200: { description: "200" } } } } },
    });

    const result = getApiOperationObjects(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      method: "get",
      path: "/hello",
      responses: {
        200: { description: "200" },
      },
    });
  });

  it("should correctly resolve the api item ref", () => {
    const ctx = createContext({
      ...openAPIMock,
      components: {
        // @ts-expect-error @typescript-eslint/ban-ts-comment
        pathItems: {
          Hello: {
            get: { responses: { 200: { description: "200" } } },
          },
        },
      },
      paths: {
        "/hello": {
          $ref: "#/components/pathItems/Hello",
        },
      },
    });

    const result = getApiOperationObjects(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      method: "get",
      path: "/hello",
      responses: {
        200: { description: "200" },
      },
    });
  });

  it("should ignore a path without operations", () => {
    const ctx = createContext({
      ...openAPIMock,
      paths: { "/hello": {} },
    });

    const result = getApiOperationObjects(ctx);
    expect(result).toHaveLength(0);
  });

  it("should ignore a path operation without responses", () => {
    const ctx = createContext({
      ...openAPIMock,
      paths: { "/hello": { get: {} } },
    });

    const result = getApiOperationObjects(ctx);
    expect(result).toHaveLength(0);
  });

  it("should throw an error if the HTTP method is invalid", () => {
    const ctx = createContext({
      ...openAPIMock,
      // @ts-expect-error @typescript-eslint/ban-ts-comment
      paths: { "/hello": { invalid: { responses: { 200: { description: "200" } } } } },
    });

    expect(() => getApiOperationObjects(ctx)).toThrowError(
      invalidHttpMethodError({ method: "invalid", path: "/hello" })
    );
  });

  it("should merge parameters from path and operation", () => {
    const ctx = createContext({
      ...openAPIMock,
      paths: {
        "/hello": {
          get: {
            parameters: [{ in: "query", name: "param2" }],
            responses: { 200: { description: "200" } },
          },
          parameters: [{ in: "query", name: "param1" }],
        },
      },
    });

    const result = getApiOperationObjects(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].parameters).toHaveLength(2);
  });

  it("should remove duplicate parameters", () => {
    const ctx = createContext({
      ...openAPIMock,
      paths: {
        "/hello": {
          get: {
            parameters: [{ in: "query", name: "param1" }],
            responses: { 200: { description: "200" } },
          },
          parameters: [{ in: "query", name: "param1" }],
        },
      },
    });

    const result = getApiOperationObjects(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].parameters).toHaveLength(1);
  });

  it("should correctly resolve the request body", () => {
    const ctx = createContext({
      ...openAPIMock,
      paths: {
        "/hello": {
          get: {
            responses: { 200: { description: "200" } },
          },
          post: {
            requestBody: { content: { "application/json": { schema: { type: "object" } } } },
            responses: { 200: { description: "200" } },
          },
        },
      },
    });

    const result = getApiOperationObjects(ctx);
    expect(result).toHaveLength(2);
    expect(result[1].requestBody).toMatchObject({
      content: { "application/json": { schema: { type: "object" } } },
    });
  });

  it("should throw an error if the status code is invalid", () => {
    const ctx = createContext({
      ...openAPIMock,
      paths: {
        "/hello": {
          get: {
            responses: { 200: { description: "200" }, invalid: { description: "invalid" } },
          },
        },
      },
    });

    expect(() => getApiOperationObjects(ctx)).toThrowError(
      invalidStatusCodeError({ method: "get", path: "/hello", statusCode: "invalid" })
    );
  });

  it("should return an empty array if there are no paths", () => {
    const ctx = createContext({
      ...openAPIMock,
    });

    const result = getApiOperationObjects(ctx);
    expect(result).toHaveLength(0);
  });

  it("should skip the path if it is empty", () => {
    const ctx = createContext({
      ...openAPIMock,
      paths: {
        // @ts-expect-error @typescript-eslint/ban-ts-comment
        "/hello": undefined,
        "/world": { get: { responses: { 200: { description: "200" } } } },
      },
    });

    const result = getApiOperationObjects(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      method: "get",
      path: "/world",
      responses: {
        200: { description: "200" },
      },
    });
  });
});
