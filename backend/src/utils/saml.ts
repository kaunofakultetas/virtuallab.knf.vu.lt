// -----------------------------------------------------------
//  [*] Utils — SAML service provider for VU SSO
//
//  The samlify glue for logging in through the university's
//  IdP (sso.vu.lt). SAML is opt-in: initSaml() is a no-op
//  unless SAML_SP_ENTITY_ID is set, and then the remaining
//  env vars (ACS URL, SP key/cert paths) become mandatory.
//  IdP metadata is fetched from VU at boot, so a failed
//  fetch fails startup rather than the first login.
//
//  Used by:
//    - index.ts — initSaml() on boot
//    - auth.route.ts — getSamlInstances() for the login
//      redirect and ACS callback, buildSpMetadata() for the
//      published SP metadata endpoint
// -----------------------------------------------------------

import * as samlify from "samlify";
import fs from "fs";

// samlify refuses to parse responses unless a schema validator is registered;
// this registers a pass-through. Assertion signatures are still enforced
// through wantAssertionsSigned below.
samlify.setSchemaValidator({ validate: (_xml: string) => Promise.resolve() });

type SamlInstances = {
    sp: ReturnType<typeof samlify.ServiceProvider>;
    idp: ReturnType<typeof samlify.IdentityProvider>;
    signingCert: string;
};

// null until initSaml() succeeds — auth.route.ts treats that as "SSO disabled".
let instances: SamlInstances | null = null;








// -----------------------------------------------------------
// initSaml
// -----------------------------------------------------------
//
// Builds the SP (our side) from the local key/cert and the
// IdP (VU's side) from its live metadata, and publishes them
// through getSamlInstances(). Returns silently when SAML is
// not configured at all; throws when it is configured but
// incompletely.
//
// Used by:
//   - index.ts — once on boot
// -----------------------------------------------------------

export async function initSaml(): Promise<void> {
    if (!process.env.SAML_SP_ENTITY_ID) return;

    const missing = [
        "SAML_ACS_URL",
        "SAML_SP_KEY_PATH",
        "SAML_SP_CERT_PATH",
    ].filter((k) => !process.env[k]);
    if (missing.length)
        throw new Error(`Missing SAML env vars: ${missing.join(", ")}`);

    const privateKey = fs.readFileSync(process.env.SAML_SP_KEY_PATH!, "utf8");
    const signingCert = fs.readFileSync(process.env.SAML_SP_CERT_PATH!, "utf8");

    const idpMetadataUrl = "https://sso.vu.lt/SSO/saml2/idp/metadata.php";
    const idpRes = await fetch(idpMetadataUrl);
    if (!idpRes.ok)
        throw new Error(`Failed to fetch VU IdP metadata: ${idpRes.status}`);
    const idpMetadata = await idpRes.text();

    const sp = samlify.ServiceProvider({
        entityID: process.env.SAML_SP_ENTITY_ID!,
        privateKey,
        signingCert,
        authnRequestsSigned: false,
        wantAssertionsSigned: true,
        nameIDFormat: ["urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"],
        assertionConsumerService: [
            {
                Binding: samlify.Constants.namespace.binding.post,
                Location: process.env.SAML_ACS_URL!,
            },
        ],
    });

    const idp = samlify.IdentityProvider({ metadata: idpMetadata });

    instances = { sp, idp, signingCert };
}








// -----------------------------------------------------------
// getSamlInstances
// -----------------------------------------------------------
//
// The initialised SP/IdP pair, or null while SAML is
// disabled or not yet initialised.
//
// Used by:
//   - auth.route.ts — every SSO endpoint
// -----------------------------------------------------------

export function getSamlInstances(): SamlInstances | null {
    return instances;
}








// -----------------------------------------------------------
// buildSpMetadata
// -----------------------------------------------------------
//
// Builds a LITNET FEDI-compliant SP metadata XML by hand:
// samlify's getMetadata() omits UIInfo, Organization,
// ContactPerson, NameIDFormat and RequestedAttribute — all
// required by the spec.
//
// Used by:
//   - auth.route.ts — the SP metadata endpoint the
//     federation reads
// -----------------------------------------------------------

export function buildSpMetadata(signingCert: string): string {
    const entityID = process.env.SAML_SP_ENTITY_ID!;
    const acsUrl = process.env.SAML_ACS_URL!;
    // Strip PEM headers/footers and whitespace for XML embedding
    const certBody = signingCert
        .replace(/-----BEGIN CERTIFICATE-----/, "")
        .replace(/-----END CERTIFICATE-----/, "")
        .replace(/\s+/g, "");

    return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor
  xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  xmlns:mdui="urn:oasis:names:tc:SAML:metadata:ui"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  entityID="${entityID}">

  <md:SPSSODescriptor
    AuthnRequestsSigned="false"
    WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">

    <md:Extensions>
      <mdui:UIInfo>
        <mdui:DisplayName xml:lang="en">KNF Virtual Lab</mdui:DisplayName>
        <mdui:DisplayName xml:lang="lt">KNF Virtualus Laboratorija</mdui:DisplayName>
        <mdui:Description xml:lang="en">Cybersecurity virtual machine lab for VU KNF students.</mdui:Description>
        <mdui:Description xml:lang="lt">Kibernetinio saugumo virtualių mašinų laboratorija VU KNF studentams.</mdui:Description>
        <mdui:PrivacyStatementURL xml:lang="en">https://virtuallab.knf.vu.lt/privacy</mdui:PrivacyStatementURL>
        <mdui:PrivacyStatementURL xml:lang="lt">https://virtuallab.knf.vu.lt/privacy</mdui:PrivacyStatementURL>
      </mdui:UIInfo>
    </md:Extensions>

    <md:KeyDescriptor use="signing">
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>${certBody}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>

    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:transient</md:NameIDFormat>

    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${acsUrl}"
      index="0"
      isDefault="true"/>

    <md:AttributeConsumingService index="1">
      <md:ServiceName xml:lang="en">KNF Virtual Lab</md:ServiceName>
      <md:ServiceName xml:lang="lt">KNF Virtualus Laboratorija</md:ServiceName>
      <md:RequestedAttribute
        NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri"
        Name="urn:oid:1.3.6.1.4.1.5923.1.1.1.10"
        FriendlyName="eduPersonTargetedID"
        isRequired="true"/>
      <md:RequestedAttribute
        NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri"
        Name="urn:oid:2.5.4.3"
        FriendlyName="cn"
        isRequired="true"/>
      <md:RequestedAttribute
        NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri"
        Name="urn:oid:1.3.6.1.4.1.25178.1.2.9"
        FriendlyName="schacHomeOrganization"
        isRequired="true"/>
      <md:RequestedAttribute
        NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri"
        Name="urn:oid:1.3.6.1.4.1.5923.1.1.1.1"
        FriendlyName="eduPersonAffiliation"
        isRequired="false"/>
      <md:RequestedAttribute
        NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri"
        Name="urn:oid:1.3.6.1.4.1.5923.1.1.1.6"
        FriendlyName="eduPersonPrincipalName"
        isRequired="false"/>
      <md:RequestedAttribute
        NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri"
        Name="urn:oid:0.9.2342.19200300.100.1.3"
        FriendlyName="mail"
        isRequired="false"/>
    </md:AttributeConsumingService>

  </md:SPSSODescriptor>

  <md:Organization>
    <md:OrganizationName xml:lang="lt">Vilniaus universitetas, Kauno fakultetas</md:OrganizationName>
    <md:OrganizationName xml:lang="en">Vilnius University, Kaunas Faculty</md:OrganizationName>
    <md:OrganizationDisplayName xml:lang="lt">VU KNF</md:OrganizationDisplayName>
    <md:OrganizationDisplayName xml:lang="en">VU KNF</md:OrganizationDisplayName>
    <md:OrganizationURL xml:lang="lt">https://knf.vu.lt</md:OrganizationURL>
    <md:OrganizationURL xml:lang="en">https://knf.vu.lt</md:OrganizationURL>
  </md:Organization>

  <md:ContactPerson contactType="technical">
    <md:GivenName>KNF Virtual Lab Admin</md:GivenName>
    <md:EmailAddress>mailto:admin@knf.vu.lt</md:EmailAddress>
  </md:ContactPerson>

  <md:ContactPerson contactType="support">
    <md:GivenName>KNF Virtual Lab Admin</md:GivenName>
    <md:EmailAddress>mailto:admin@knf.vu.lt</md:EmailAddress>
  </md:ContactPerson>

</md:EntityDescriptor>`;
}
