import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "release/**"] },
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // The runner drops fields from omp's wire objects by destructuring them out of a rest spread.
  { files: ["runner/**/*.ts"], rules: { "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }] } },
);
