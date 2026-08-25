import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

const applicationFiles = ["src/**/*.{ts,tsx}", "tests/**/*.ts"];

export default tseslint.config(
  {
    ignores: [
      ".scratch/**",
      ".test-data/**",
      "dist/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: applicationFiles,
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: applicationFiles,
  })),
  {
    files: applicationFiles,
    languageOptions: {
      parserOptions: {
        project: [
          "./tsconfig.node.json",
          "./tsconfig.web.json",
          "./tsconfig.e2e.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: [
      "eslint.config.js",
      "playwright.config.ts",
      "vite.config.ts",
      "vitest.config.ts",
      "src/runtime/**/*.ts",
      "src/server/**/*.ts",
      "tests/**/*.ts",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["src/protocol/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../runtime/**",
                "../server/**",
                "../web/**",
                "@fastify/**",
                "fastify",
                "node:*",
                "react",
                "react-dom",
              ],
              message: "协议必须保持传输、Runtime、浏览器和 Node 无关。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/runtime/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../server/**",
                "../web/**",
                "../../server/**",
                "../../web/**",
                "@fastify/**",
                "fastify",
                "react",
                "react-dom",
              ],
              message: "Runtime 不能依赖服务传输或浏览器实现。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../runtime/**",
                "../server/**",
                "@fastify/**",
                "fastify",
                "node:*",
              ],
              message: "浏览器只能依赖固定协议和窄 RuntimeClient。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/server/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../web/**", "../../web/**"],
              message: "服务适配器不能依赖浏览器实现。",
            },
          ],
        },
      ],
    },
  },
);
