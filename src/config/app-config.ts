import packageJson from "../../package.json";

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: "SmartRoad",
  version: packageJson.version,
  copyright: `© ${currentYear}, SmartRoad.`,
  meta: {
    title: "SmartRoad",
    description: "Intelligent roadworks traffic monitoring and custom vehicle detection dashboard.",
  },
};
