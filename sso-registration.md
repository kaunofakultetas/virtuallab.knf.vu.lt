# SAML2 SP Registration Request — KNF Virtual Lab

---

## 1. Service Description

**Service name:** KNF Virtual Lab (`virtuallab.knf.vu.lt`)

**Description:** A Proxmox-based virtual machine lab for hands-on cybersecurity and red teaming exercises. Students authenticate via VU SSO to receive an isolated lab environment with a pre-configured virtual machine and browser-based console access.

**Service URL:** https://virtuallab.knf.vu.lt  
**Privacy statement:** https://virtuallab.knf.vu.lt/privacy (no authentication required)  
**Audience:** VU students and faculty enrolled in KNF cybersecurity courses.

---

## 2. SP Technical Parameters

| Parameter | Value |
|---|---|
| **Entity ID** | `https://virtuallab.knf.vu.lt/api/auth/saml/metadata` |
| **Metadata URL** | `https://virtuallab.knf.vu.lt/api/auth/saml/metadata` |
| **ACS URL** | `https://virtuallab.knf.vu.lt/api/auth/sso/callback` |
| **ACS Binding** | `urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST` |
| **NameID Format** | `urn:oasis:names:tc:SAML:2.0:nameid-format:persistent` (for eduPersonTargetedID) |
| **AuthnRequests signed** | No |
| **Wants assertions signed** | Yes |
| **Protocol** | SAML 2.0 Web Browser SSO Profile |

---

## 3. Requested Attributes

| FriendlyName | OID (Name URI) | Required | Purpose |
|---|---|---|---|
| `eduPersonTargetedID` | `urn:oid:1.3.6.1.4.1.5923.1.1.1.10` | **Yes** | Primary user identifier — opaque persistent per-SP handle |
| `cn` | `urn:oid:2.5.4.3` | **Yes** | Display name shown in the UI |
| `schacHomeOrganization` | `urn:oid:1.3.6.1.4.1.25178.1.2.9` | **Yes** | Confirm user belongs to VU |
| `eduPersonAffiliation` | `urn:oid:1.3.6.1.4.1.5923.1.1.1.1` | No | Distinguish student / faculty / staff |
| `eduPersonPrincipalName` | `urn:oid:1.3.6.1.4.1.5923.1.1.1.6` | No | Human-readable username (not stored) |
| `mail` | `urn:oid:0.9.2342.19200300.100.1.3` | No | Optional contact address |

`eduPersonTargetedID` is requested as a persistent NameID (`urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`). The opaque value is stored as the user's account key; the user's real username is never stored.

---

## 4. SP Signing Certificate

The SP uses the following RSA-2048 certificate for response-signature verification. AuthnRequests are **not** signed.

**Subject:** `CN=Virtual Lab, OU=Kauno Fakultetas, O=Vilnius University, C=LT`  
**Valid:** 2026-05-26 → 2036-05-23  
**Email:** admin@knf.vu.lt

```
-----BEGIN CERTIFICATE-----
MIIEAzCCAuugAwIBAgIUBArLjlrv6H+kAS0QkpnXeyZ9S/UwDQYJKoZIhvcNAQEL
BQAwgZAxCzAJBgNVBAYTAkxUMRMwEQYDVQQIDApTb21lLVN0YXRlMRswGQYDVQQK
DBJWaWxuaXVzIFVuaXZlcnNpdHkxGTAXBgNVBAsMEEthdW5vIEZha3VsdGV0YXMx
FDASBgNVBAMMC1ZpcnR1YWwgTGFiMR4wHAYJKoZIhvcNAQkBFg9hZG1pbkBrbmYu
dnUubHQwHhcNMjYwNTI2MDg1MDM3WhcNMzYwNTIzMDg1MDM3WjCBkDELMAkGA1UE
BhMCTFQxEzARBgNVBAgMClNvbWUtU3RhdGUxGzAZBgNVBAoMElZpbG5pdXMgVW5p
dmVyc2l0eTEZMBcGA1UECwwQS2F1bm8gRmFrdWx0ZXRhczEUMBIGA1UEAwwLVmly
dHVhbCBMYWIxHjAcBgkqhkiG9w0BCQEWD2FkbWluQGtuZi52dS5sdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBALC2y7vS6mGCjbnPk2Ln/Ry6wB4iWdcy
0w6JRrH6jQzbjlZp6W8a6W/RV+kTHj26HW7HWJB2nO70N0/rPgQHIiSpuj60gpjR
Yllzl5yBPVjz+VoKGvvJlZfOXa6VrtTIQN9KePWHQhXt17YwvtOAvRkaiY/uziNV
LCRudvz2cWTDGXFw7dWDPdTW8+LjBaFoEeGrjKwgV8Qe+a0TR86iLp17FIjE9pl7
kX95CkaG0TsH4EbIoicbJbB63cLiylNoc/HZVJsL5kX7F/B6UK+HaFwTte7FQMmL
HL7S7hZf2v2X//Oz6Gt9vhhBhzgruUlnETbYlHvjL6Al9EKuucvWyrMCAwEAAaNT
MFEwHQYDVR0OBBYEFBQqeebXI9ObYUzCiM2BWqL+fLX1MB8GA1UdIwQYMBaAFBQq
eebXI9ObYUzCiM2BWqL+fLX1MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBAESdJFE4IJkY3LegCGkBUdx8zoWePTxoiAIpKRLxpTqpZky68bM1v4wi
KnLWw/KZJqhi03tpNB2wk1utXLDdBNqOXE3Cjg4pLlRWAZ3gQPndUI1rZeR1uEpU
DmfuEKf7c6RZ0W/P/CahgPJ9VwN3d2HZ6UxgBtzC6HA9pd3syzAn5F/1kUtnW/V9
NP75l9F7OWZele/UqjJyfjRfAWEqt6AV2Nrgbi/87l7gE36vWvRSGNo+mjBeIwDi
G5PjFQmFIT623qf9XcKvNEZfdti44ctp9Ava1BxbiGQuqt/iX4LYdoPIxpd9kdh7
JL+2veS2eTwlR+CxLzMN3r6WwBTG4nE=
-----END CERTIFICATE-----
```

---

## 5. SP Metadata XML

The live metadata is always available at:

```
GET https://virtuallab.knf.vu.lt/api/auth/saml/metadata
Content-Type: application/xml
```

Static copy for reference:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor
  xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  xmlns:mdui="urn:oasis:names:tc:SAML:metadata:ui"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  entityID="https://virtuallab.knf.vu.lt/api/auth/saml/metadata">

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
      </mdui:UIInfo>
    </md:Extensions>

    <md:KeyDescriptor use="signing">
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>
MIIEAzCCAuugAwIBAgIUBArLjlrv6H+kAS0QkpnXeyZ9S/UwDQYJKoZIhvcNAQEL
BQAwgZAxCzAJBgNVBAYTAkxUMRMwEQYDVQQIDApTb21lLVN0YXRlMRswGQYDVQQK
DBJWaWxuaXVzIFVuaXZlcnNpdHkxGTAXBgNVBAsMEEthdW5vIEZha3VsdGV0YXMx
FDASBgNVBAMMC1ZpcnR1YWwgTGFiMR4wHAYJKoZIhvcNAQkBFg9hZG1pbkBrbmYu
dnUubHQwHhcNMjYwNTI2MDg1MDM3WhcNMzYwNTIzMDg1MDM3WjCBkDELMAkGA1UE
BhMCTFQxEzARBgNVBAgMClNvbWUtU3RhdGUxGzAZBgNVBAoMElZpbG5pdXMgVW5p
dmVyc2l0eTEZMBcGA1UECwwQS2F1bm8gRmFrdWx0ZXRhczEUMBIGA1UEAwwLVmly
dHVhbCBMYWIxHjAcBgkqhkiG9w0BCQEWD2FkbWluQGtuZi52dS5sdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBALC2y7vS6mGCjbnPk2Ln/Ry6wB4iWdcy
0w6JRrH6jQzbjlZp6W8a6W/RV+kTHj26HW7HWJB2nO70N0/rPgQHIiSpuj60gpjR
Yllzl5yBPVjz+VoKGvvJlZfOXa6VrtTIQN9KePWHQhXt17YwvtOAvRkaiY/uziNV
LCRudvz2cWTDGXFw7dWDPdTW8+LjBaFoEeGrjKwgV8Qe+a0TR86iLp17FIjE9pl7
kX95CkaG0TsH4EbIoicbJbB63cLiylNoc/HZVJsL5kX7F/B6UK+HaFwTte7FQMmL
HL7S7hZf2v2X//Oz6Gt9vhhBhzgruUlnETbYlHvjL6Al9EKuucvWyrMCAwEAAaNT
MFEwHQYDVR0OBBYEFBQqeebXI9ObYUzCiM2BWqL+fLX1MB8GA1UdIwQYMBaAFBQq
eebXI9ObYUzCiM2BWqL+fLX1MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBAESdJFE4IJkY3LegCGkBUdx8zoWePTxoiAIpKRLxpTqpZky68bM1v4wi
KnLWw/KZJqhi03tpNB2wk1utXLDdBNqOXE3Cjg4pLlRWAZ3gQPndUI1rZeR1uEpU
DmfuEKf7c6RZ0W/P/CahgPJ9VwN3d2HZ6UxgBtzC6HA9pd3syzAn5F/1kUtnW/V9
NP75l9F7OWZele/UqjJyfjRfAWEqt6AV2Nrgbi/87l7gE36vWvRSGNo+mjBeIwDi
G5PjFQmFIT623qf9XcKvNEZfdti44ctp9Ava1BxbiGQuqt/iX4LYdoPIxpd9kdh7
JL+2veS2eTwlR+CxLzMN3r6WwBTG4nE=
          </ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>

    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://virtuallab.knf.vu.lt/api/auth/sso/callback"
      index="0"
      isDefault="true"/>

    <md:AttributeConsumingService index="1">
      <md:ServiceName xml:lang="en">KNF Virtual Lab</md:ServiceName>
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

</md:EntityDescriptor>
```

---

## 6. Organization

| Field | Value |
|---|---|
| **OrganizationName (lt)** | Vilniaus universitetas, Kauno fakultetas |
| **OrganizationName (en)** | Vilnius University, Kaunas Faculty |
| **OrganizationURL** | https://knf.vu.lt |

---

## 7. Contact Persons

| Type | Name | Email |
|---|---|---|
| Technical | KNF Virtual Lab Admin | admin@knf.vu.lt |
| Support | KNF Virtual Lab Admin | admin@knf.vu.lt |

---

## 8. Authentication Flow

1. User visits `https://virtuallab.knf.vu.lt` and clicks **Login through VU SSO**.
2. Browser is redirected to `https://sso.vu.lt/SSO/saml2/idp/SSOService.php` with an unsigned `AuthnRequest` (HTTP-Redirect binding).
3. User authenticates at VU SSO.
4. IdP posts a signed `SAMLResponse` to `https://virtuallab.knf.vu.lt/api/auth/sso/callback` (HTTP-POST binding).
5. SP verifies the assertion signature, extracts `eduPersonPrincipalName` as the user identifier, and issues a session cookie.
6. User is redirected to the lab dashboard.

No data is stored beyond the `eduPersonPrincipalName` value used as the account key and `last_login` timestamp. The service does not share user data with third parties.

---

## 9. Notes for the SSO Manager

- The live SP metadata endpoint (`/api/auth/saml/metadata`) is available for direct import if that is preferred over the static XML above.
- The SP is **not** currently registered in the LITNET FEDI federation — registration via VU SSO direct SP agreement is requested.
- The SP certificate is self-signed and valid for 10 years (until 2036-05-23). We will notify `sso-admin@vu.lt` before renewal.
- If attribute release policy requires justification: `eduPersonPrincipalName` is used solely to identify returning users across sessions (no password is stored for SSO users).
