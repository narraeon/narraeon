import { V1ProtocolError } from "../../protocol/v1.ts";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import {
  maxPortableContentArchiveBase64Characters,
  maxPortableContentArchiveBytes,
} from "../../protocol/contentTree.ts";
import { type ContentWorkspace } from "../content/ContentWorkspace.ts";
import {
  convertSillyTavernContent,
  inspectSillyTavernContent,
} from "../content/SillyTavernContent.ts";
import type { CommandFor } from "./Command.ts";

export async function handleContentCommand(
  request: CommandFor<"content">,
  content: ContentWorkspace,
  locale: AppLocale,
): Promise<unknown> {
  switch (request.type) {
    case "content.create":
      return content.createCurrentTreeContentPackage(request.gameplay);
    case "content.gameplay.set":
      return content.setCurrentTreeContentGameplayScheme(
        request.packageId,
        request.scheme,
      );
    case "content.create-sample":
      return content.createSampleContentPackage(request.locale);
    case "content.scripts.read":
      return content.packageScriptPermissions(request.packageId);
    case "content.scripts.set":
      return content.packageScriptPermissions(
        request.packageId,
        request.enabled,
      );
    case "content.read":
      return content.readCurrentTreeContentPackage(request.packageId);
    case "content.replace":
      return content.replaceCurrentTreeContentPackage(
        request.packageId,
        request.files,
        { baseTreeRevision: request.baseTreeRevision },
      );
    case "content.copy":
      return content.copyCurrentTreeContentPackage(request.packageId);
    case "content.delete":
      await content.deleteCurrentTreeContentPackage(request.packageId);
      return { deleted: true };
    case "content.rename":
      return content.renameCurrentTreeContentPackage(
        request.packageId,
        request.name,
      );
    case "content.import":
      return content.importPortableContentPackageArchive(
        decodePortableContentArchive(request.archiveBase64),
        request.title === undefined ? {} : { title: request.title },
      );
    case "content.sillytavern.inspect":
    case "content.sillytavern.preview":
    case "content.sillytavern.import": {
      try {
        if (
          request.source.length > 12 * 1024 * 1024 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
            request.source,
          )
        )
          throw new Error("Invalid source encoding");
        const source = Buffer.from(request.source, "base64");
        if (source.toString("base64") !== request.source)
          throw new Error("Invalid source encoding");
        if (request.type === "content.sillytavern.inspect")
          return inspectSillyTavernContent(source);
        const converted = convertSillyTavernContent(
          source,
          request.selection,
          locale,
        );
        content.validateCurrentTreeContentPackage(converted.files);
        if (request.type === "content.sillytavern.preview")
          return {
            ...converted,
            inspection: content.inspectCurrentTreeContentPackage(
              converted.files,
            ),
          };
        return await content.importSillyTavernContent(
          request.name,
          converted.files,
        );
      } catch (error) {
        throw new V1ProtocolError(
          "invalid_request",
          error instanceof Error
            ? error.message
            : "Invalid SillyTavern content",
        );
      }
    }
    case "content.export": {
      const exported = await content.exportCurrentTreeContentPackage(
        request.packageId,
      );
      return {
        fileName: exported.fileName,
        base64: exported.archive.toString("base64"),
      };
    }
  }
}

function decodePortableContentArchive(archiveBase64: string): Buffer {
  if (
    archiveBase64.length === 0 ||
    archiveBase64.length > maxPortableContentArchiveBase64Characters ||
    archiveBase64.length % 4 !== 0
  )
    throw invalidContentArchiveUpload();
  const archive = Buffer.from(archiveBase64, "base64");
  if (
    archive.byteLength > maxPortableContentArchiveBytes ||
    archive.toString("base64") !== archiveBase64
  )
    throw invalidContentArchiveUpload();
  return archive;
}

function invalidContentArchiveUpload(): V1ProtocolError {
  return new V1ProtocolError(
    "invalid_request",
    "content.import.archiveBase64 is not a supported content-package ZIP",
  );
}
