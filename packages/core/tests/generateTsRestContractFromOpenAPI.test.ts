import ts from "typescript";

import { generateTsRestContractFromOpenAPI } from "../src/generateTsRestContractFromOpenAPI";

const OPENAPI_DOCS = [
  "https://raw.githubusercontent.com/OAI/OpenAPI-Specification/main/examples/v3.0/petstore.yaml",
  "https://raw.githubusercontent.com/teamdigitale/api-openapi-samples/master/openapi-v3/defibrillatori-example.yaml",
];

describe("generateTsRestContractFromOpenAPI", () => {
  it.each(OPENAPI_DOCS)("should successfully transpile module without ts errors", async (input) => {
    const module = await generateTsRestContractFromOpenAPI({
      input,
    });

    const output = ts.transpileModule(module, {
      compilerOptions: {
        module: ts.ModuleKind.NodeNext,
        noEmit: true,
        strict: true,
        target: ts.ScriptTarget.ESNext,
      },
      reportDiagnostics: true,
    });

    expect(output.diagnostics).toHaveLength(0);
  });

  it.each(OPENAPI_DOCS)("should match snapshot for %s", async (input) => {
    const module = await generateTsRestContractFromOpenAPI({
      input,
    });

    expect(module).toMatchSnapshot();
  });
});
